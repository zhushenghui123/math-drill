"""core/store.py —— 持久层：blob 读写 + 版本仲裁（ADR-002）+ 四张表的建表归属。

持久层分两类（ADR-007，别再混淆）：
  ① **blob**：服务端持有的**客户端自有状态** JSON（cards/daily/settings/checkins/game/notes/kp_state），
     落 `blob.json`（原子替换写入）。合并规则的真值是 `contracts/blob_merge.md`。
  ② **sqlite**：只保四件 —— `questions` / `kp` / `attempts` / `meta`。建表与 `schema_version`
     迁移归本文件（铁律 3：持久层在 core，模块不建表）。

关键不变量：
  I5 `attempts` 由判定器独占写入 —— 本模块只接受 `core.judge` 产出的判决结构，
     **不接受客户端提交的 `correct`**；`ts` 一律取服务端时间。
  冲突仲裁 = `server_version` 单调递增 + 客户端 `base_version` 匹配；不匹配 → `ConflictError`
     并回传服务端最新 blob（§3.5 / ADR-002）。
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from pathlib import Path

from contracts.answer_types import Verdict

__all__ = ["ConflictError", "Store", "SCHEMA_VERSION"]

#: 2 = 加 `agent_notes` 表（ADR-017）；3 = 加 `agent_difficulty` 表（ADR-018）；
#: 4 = 加 `question_provenance` 旁表（ADR-019，语料题出处/题号来源/验证状态）。
#: **注意迁移现状**：本文件的 schema 变更至今
#: **全是"加表"**，靠 `CREATE TABLE IF NOT EXISTS` 每次启动幂等地补上；**没有**真正的
#: 步进迁移（加列/改类型没有机制）。故 `ensure_schema` 允许把已记录的版本号**前推**
#: （见其 docstring）；哪天要加列，必须先补步进迁移，不许再靠这一手。
SCHEMA_VERSION = 4

#: §3.5 的合并规则（真值副本在 contracts/blob_merge.md；两处不一致以那份为准）
MERGE_RULES = {
    "cards": "newer_wins",
    "daily": "newer_wins",
    "checkins": "newer_wins",
    "game": "newer_wins",
    "notes": "newer_wins",
    "cardDeck": "newer_wins",
    "customQ": "newer_wins",
    "kp_state": "newer_wins",
    "classrooms": "newer_wins",
    "chats": "newer_wins",
    "settings": "server_authoritative",
    "attempts": "retired",          # ADR-007：已退役出 blob
}
DEFAULT_RULE = "newer_wins"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
    id             TEXT PRIMARY KEY,
    bundle_version INTEGER,
    kid            TEXT,
    type           TEXT,
    answer_type    TEXT NOT NULL,
    stem           TEXT,
    options        TEXT,
    answer         TEXT NOT NULL,
    analysis       TEXT,
    difficulty     INTEGER,
    gen_params     TEXT,
    source         TEXT
);
CREATE TABLE IF NOT EXISTS kp (
    id      TEXT PRIMARY KEY,
    title   TEXT,
    chapter TEXT,
    subject TEXT,
    exam    TEXT,
    related TEXT
);
CREATE TABLE IF NOT EXISTS attempts (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      REAL    NOT NULL,
    qid     TEXT    NOT NULL,
    kid     TEXT,
    verdict TEXT    NOT NULL,
    correct INTEGER,
    user_ms INTEGER,
    device  TEXT
);
CREATE TABLE IF NOT EXISTS agent_notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    qid        TEXT    NOT NULL,
    attempt_id INTEGER,
    kind       TEXT    NOT NULL,
    summary    TEXT    NOT NULL,
    reason     TEXT,
    author     TEXT    NOT NULL,
    src        TEXT    NOT NULL,
    ts         REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_notes_qid ON agent_notes(qid, id);
CREATE TABLE IF NOT EXISTS agent_difficulty (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    qid        TEXT    NOT NULL,
    difficulty INTEGER NOT NULL,
    reason     TEXT,
    author     TEXT    NOT NULL,
    src        TEXT    NOT NULL,
    ts         REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_difficulty_qid ON agent_difficulty(qid, id);
CREATE TABLE IF NOT EXISTS question_provenance (
    qid               TEXT PRIMARY KEY,
    bank              TEXT    NOT NULL,
    book_title        TEXT,
    page_idx          INTEGER,
    bbox              TEXT,
    blocks            TEXT,
    number_source     TEXT    NOT NULL,
    number_evidence   TEXT,
    verify            TEXT    NOT NULL,
    segment_schema    INTEGER NOT NULL,
    whitelist_version TEXT,
    created_at        REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_question_provenance_verify ON question_provenance(verify);
"""


class ConflictError(Exception):
    """版本不匹配（§3.5）：携带服务端最新 blob，供客户端重放。"""

    def __init__(self, latest: dict) -> None:
        self.latest = latest
        super().__init__(f"base_version 不匹配，服务端最新 server_version={latest['server_version']}")


def _updated_at(section) -> float:
    """取分段的 updated_at（缺失/非法一律当 0，即最旧）。"""
    if isinstance(section, dict):
        v = section.get("updated_at")
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, str):
            try:
                return float(v)
            except ValueError:
                return 0.0
    return 0.0


class Store:
    """一个数据目录 = 一份状态（部署态 `/var/lib/math-drill`，开发态随便指）。"""

    def __init__(self, data_dir: str | os.PathLike, *, db_name: str = "math-drill.db",
                 blob_name: str = "blob.json") -> None:
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = self.data_dir / db_name
        self.blob_path = self.data_dir / blob_name
        # HTTP 是每请求一线程（ThreadingHTTPServer），故连接跨线程共享 + 自己加锁串行化
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.ensure_schema()

    # ------------------------------------------------------------ 建表
    def ensure_schema(self) -> int:
        """建表 + `schema_version`（本文件的独占职责；模块不得建表）。

        版本号**只前推、不回退**：老库（记录着 1）在本函数跑完后会被写成当前版本，
        因为至今全部 schema 变更都是"加表"，`CREATE TABLE IF NOT EXISTS` 已经幂等地
        把结构补齐了。**这不是通用迁移机制**——加列/改类型那天必须补步进迁移，
        否则版本号会变成一句假话（ADR-017 代价 5）。
        """
        with self._lock:
            self.conn.executescript(_SCHEMA)
            cur = self.conn.execute("SELECT value FROM meta WHERE key='schema_version'")
            row = cur.fetchone()
            if row is None:
                self.conn.execute("INSERT INTO meta(key, value) VALUES('schema_version', ?)",
                                  (str(SCHEMA_VERSION),))
            elif int(row["value"]) < SCHEMA_VERSION:
                self.conn.execute("UPDATE meta SET value = ? WHERE key='schema_version'",
                                  (str(SCHEMA_VERSION),))
            self.conn.commit()
            return self.schema_version

    @property
    def schema_version(self) -> int:
        with self._lock:
            row = self.conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
            return int(row["value"]) if row else 0

    # ------------------------------------------------------------ blob
    def get_blob(self) -> dict:
        """返回服务端持有的完整 blob（含 server_version）。"""
        with self._lock:
            if not self.blob_path.exists():
                return {"server_version": 0, "data": {}}
            with open(self.blob_path, encoding="utf-8") as f:
                blob = json.load(f)
            blob.setdefault("server_version", 0)
            blob.setdefault("data", {})
            return blob

    def _write_blob(self, blob: dict) -> None:
        """原子替换 + fsync（断电不产生半个文件）。"""
        with self._lock:
            tmp = self.blob_path.with_suffix(".json.tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(blob, f, ensure_ascii=False, sort_keys=True)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.blob_path)
            dir_fd = os.open(self.data_dir, os.O_DIRECTORY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)

    def put_blob(self, base_version: int, incoming: dict) -> dict:
        """客户端整块 PUT。成功返回新 blob；版本不匹配抛 ConflictError（带最新 blob）。"""
        if not isinstance(incoming, dict):
            raise ValueError("incoming 必须是 dict")
        current = self.get_blob()
        if int(base_version) != int(current["server_version"]):
            raise ConflictError(current)

        merged = dict(current["data"])
        for key, value in incoming.items():
            rule = MERGE_RULES.get(key, DEFAULT_RULE)
            if rule == "retired":
                continue                     # attempts 永不进 blob（ADR-007）
            if rule == "server_authoritative":
                continue                     # settings：服务端是真相源，客户端整块 PUT 不动它
            if rule == "newer_wins" and key in merged:
                if _updated_at(value) <= _updated_at(merged[key]):
                    continue
            merged[key] = value

        blob = {"server_version": int(current["server_version"]) + 1, "data": merged}
        self._write_blob(blob)
        return blob

    def put_settings(self, base_version: int, settings: dict) -> dict:
        """§3.5：客户端改设置 = **显式 PUT 特殊段**（避免两设备互踩）。"""
        if not isinstance(settings, dict):
            raise ValueError("settings 必须是 dict")
        current = self.get_blob()
        if int(base_version) != int(current["server_version"]):
            raise ConflictError(current)
        merged = dict(current["data"])
        merged["settings"] = settings
        blob = {"server_version": int(current["server_version"]) + 1, "data": merged}
        self._write_blob(blob)
        return blob

    # ------------------------------------------------------------ attempts（I5）
    _VERDICT_TO_CORRECT = {
        Verdict.SERVER_TRUE.value: 1,
        Verdict.SERVER_FALSE.value: 0,
        Verdict.UNDECIDABLE.value: None,
    }

    def record_attempt(self, *, qid: str, kid: str | None, result: dict,
                       user_ms: int | None = None, device: str | None = None) -> int:
        """写入一条 attempt。**只接受 core.judge 的输出结构**（I5）。

        `result` 必须带 `verdict`；`correct` 由本方法按判决推导，客户端无法直接提交——
        传 `correct` 而不传 `verdict` 会直接报错（不是"忽略"）。
        """
        if not isinstance(result, dict) or "verdict" not in result:
            raise ValueError("attempt 必须来自 core.judge 的判决（缺 verdict 字段）")
        verdict = result["verdict"]
        allowed = {v.value for v in Verdict}
        if verdict not in allowed:
            raise ValueError(f"未知 verdict: {verdict!r}")
        if verdict == Verdict.SELF_REPORTED.value:
            reported = result.get("correct")
            if reported is None:
                raise ValueError("self_reported 必须带用户自评 correct（True/False）")
            correct = 1 if reported else 0
        else:
            correct = self._VERDICT_TO_CORRECT[verdict]

        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO attempts(ts, qid, kid, verdict, correct, user_ms, device) "
                "VALUES(?,?,?,?,?,?,?)",
                (time.time(), qid, kid, verdict, correct, user_ms, device),
            )
            self.conn.commit()
            return int(cur.lastrowid)

    def list_attempts(self, *, qid: str | None = None) -> list[dict]:
        sql = "SELECT * FROM attempts"
        args: tuple = ()
        if qid:
            sql += " WHERE qid = ?"
            args = (qid,)
        sql += " ORDER BY id"
        with self._lock:
            return [dict(r) for r in self.conn.execute(sql, args).fetchall()]

    def list_attempt_stats(self) -> list[dict]:
        """按题聚合的只读视图：`[{qid, n, correct, first_ts, last_ts}, …]`。

        为什么在 SQL 里聚合：题库视图要回答"这题做了没有 / 对几次错几次"，
        而 `list_attempts()` 会把**全部**行搬进内存——题量上去后这是 O(全部历史)。
        """
        with self._lock:
            rows = self.conn.execute(
                "SELECT qid, COUNT(*) AS n, SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) AS correct,"
                " MIN(ts) AS first_ts, MAX(ts) AS last_ts FROM attempts GROUP BY qid"
            ).fetchall()
            return [dict(r) for r in rows]

    # ------------------------------------------------------------ agent 复盘（ADR-017）
    def record_note(self, *, qid: str, kind: str, summary: str, reason: str | None = None,
                    author: str = "agent", src: str = "offline", attempt_id: int | None = None,
                    ts: float | None = None) -> int:
        """写入一条 agent 复盘。**没有任何 HTTP 端点调它**（ADR-017 决策 2：写权仍关闭）。

        当前唯一调用方是离线灌库/本地演示；将来若给 agent 开写权，必须先按
        ADR-015 代价 5 重开 ADR-002（blob 双写者），本方法是那一步的落点。
        """
        if not qid or not summary:
            raise ValueError("agent_notes 至少要 qid 与 summary")
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO agent_notes(qid, attempt_id, kind, summary, reason, author, src, ts) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (qid, attempt_id, kind, summary, reason, author, src,
                 time.time() if ts is None else ts),
            )
            self.conn.commit()
            return int(cur.lastrowid)

    def list_notes(self, *, qid: str | None = None) -> list[dict]:
        """agent 复盘（按 id 升序；一次给全或按题过滤）。"""
        sql = ("SELECT id, qid, attempt_id, kind, summary, reason, author, src, ts "
               "FROM agent_notes")
        args: tuple = ()
        if qid:
            sql += " WHERE qid = ?"
            args = (qid,)
        sql += " ORDER BY id"
        with self._lock:
            return [dict(r) for r in self.conn.execute(sql, args).fetchall()]

    def note_count(self) -> int:
        with self._lock:
            return int(self.conn.execute("SELECT COUNT(*) AS c FROM agent_notes").fetchone()["c"])

    def record_difficulty(self, *, qid: str, difficulty: int, reason: str | None = None,
                          author: str = "agent", src: str = "agent",
                          ts: float | None = None) -> int:
        """写入一条 **agent 判定的难度**（ADR-018）。append-only：**取最新一条为准**。

        为什么不覆盖 `questions.difficulty`：题库自带难度是**数据管线**的产物（来源可溯、可重灌），
        agent 判定是**使用中产生的标注**。两者混在一列里，重新灌库那天 agent 的判定就会被抹掉，
        而且再也分不清"这个数字是谁说的"。所以并存两处，读取时**agent 优先**。
        """
        d = int(difficulty)
        if not 1 <= d <= 4:
            raise ValueError(f"difficulty 必须是 1-4 的整数，收到 {difficulty!r}")
        if not qid:
            raise ValueError("qid 不能为空")
        with self._lock:
            cur = self.conn.execute(
                "INSERT INTO agent_difficulty(qid, difficulty, reason, author, src, ts) "
                "VALUES(?,?,?,?,?,?)",
                (qid, d, reason, author, src, time.time() if ts is None else ts),
            )
            self.conn.commit()
            return int(cur.lastrowid)

    def latest_difficulties(self) -> dict[str, dict]:
        """qid → **最新一条** agent 难度（一次取全，题量级小；读取面按 id 递增覆盖）。"""
        out: dict[str, dict] = {}
        with self._lock:
            rows = self.conn.execute(
                "SELECT id, qid, difficulty, reason, author, src, ts "
                "FROM agent_difficulty ORDER BY id"
            ).fetchall()
        for r in rows:
            out[r["qid"]] = dict(r)
        return out

    # ------------------------------------------------------------ questions / kp
    def load_questions(self, rows: list[dict]) -> int:
        """灌库（T6 的 `scripts/db_init.py` 调用）——幂等 upsert。"""
        n = 0
        with self._lock:
            for r in rows:
                self.conn.execute(
                    "INSERT INTO questions(id, bundle_version, kid, type, answer_type, stem, options,"
                    " answer, analysis, difficulty, gen_params, source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) "
                    "ON CONFLICT(id) DO UPDATE SET bundle_version=excluded.bundle_version, kid=excluded.kid,"
                    " type=excluded.type, answer_type=excluded.answer_type, stem=excluded.stem,"
                    " options=excluded.options, answer=excluded.answer, analysis=excluded.analysis,"
                    " difficulty=excluded.difficulty, gen_params=excluded.gen_params, source=excluded.source",
                    (r["id"], r.get("bundle_version"), r.get("kid"), r.get("type"),
                     r["answer_type"], r.get("stem"), r.get("options"), r["answer"],
                     r.get("analysis"), r.get("difficulty"), r.get("gen_params"), r.get("source")),
                )
                n += 1
            self.conn.commit()
            return n

    def get_question(self, qid: str) -> tuple[str, str] | None:
        """给判定器用的 lookup：返回 (answer_type, answer)，没有则 None。"""
        with self._lock:
            row = self.conn.execute(
                "SELECT answer_type, answer FROM questions WHERE id = ?", (qid,)
            ).fetchone()
            return (row["answer_type"], row["answer"]) if row else None

    def question_count(self) -> int:
        with self._lock:
            return int(self.conn.execute("SELECT COUNT(*) AS c FROM questions").fetchone()["c"])

    # ------------------------------------------------------------ 语料出处（ADR-019）
    def record_provenance(self, rows: list[dict]) -> int:
        """写入语料题出处（旁表，幂等 upsert）。`questions` 表**不加列**（ADR-019 决策 1）。"""
        n = 0
        with self._lock:
            for r in rows:
                self.conn.execute(
                    "INSERT INTO question_provenance(qid, bank, book_title, page_idx, bbox, blocks,"
                    " number_source, number_evidence, verify, segment_schema, whitelist_version, created_at)"
                    " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
                    " ON CONFLICT(qid) DO UPDATE SET bank=excluded.bank, book_title=excluded.book_title,"
                    " page_idx=excluded.page_idx, bbox=excluded.bbox, blocks=excluded.blocks,"
                    " number_source=excluded.number_source, number_evidence=excluded.number_evidence,"
                    " verify=excluded.verify, segment_schema=excluded.segment_schema,"
                    " whitelist_version=excluded.whitelist_version",
                    (r["qid"], r["bank"], r.get("book_title"), r.get("page_idx"), r.get("bbox"),
                     r.get("blocks"), r["number_source"], r.get("number_evidence"), r["verify"],
                     r["segment_schema"], r.get("whitelist_version"), time.time()),
                )
                n += 1
            self.conn.commit()
            return n

    def list_provenance(self, *, qid: str | None = None) -> list[dict]:
        sql = ("SELECT qid, bank, book_title, page_idx, bbox, blocks, number_source,"
               " number_evidence, verify, segment_schema, whitelist_version FROM question_provenance")
        args: tuple = ()
        if qid:
            sql += " WHERE qid = ?"
            args = (qid,)
        with self._lock:
            return [dict(r) for r in self.conn.execute(sql + " ORDER BY qid", args).fetchall()]

    def practice_pool(self) -> list[dict]:
        """**练习池**：排除 `verify='unverified'` 的语料题（ADR-019 决策 4 / DATA_PIPELINE §2）。

        没有 provenance 行的题（生成器自产）视为 `auto_verified` ⇒ 照旧进池。
        为什么不改 `list_questions()`：那个方法还有别的调用方（题库栏目要**看得见**未审核的题），
        两件事必须分开 —— "看得见"与"能拿来练"是两条不同的门。
        """
        with self._lock:
            rows = self.conn.execute(
                "SELECT q.id, q.kid, q.type, q.answer_type, q.stem, q.options, q.answer, q.analysis,"
                " q.difficulty, q.source FROM questions q"
                " LEFT JOIN question_provenance p ON p.qid = q.id"
                " WHERE COALESCE(p.verify, 'auto_verified') != 'unverified'"
                " ORDER BY q.id"
            ).fetchall()
            return [dict(r) for r in rows]

    def verify_map(self) -> dict[str, str]:
        """qid → 验证状态（没有旁表行的生成器题视为 `auto_verified`）。

        为什么要单独一个方法：题库栏目要**在界面上标出"未审核"**（ADR-019 代价 3）——
        这些题看得见、点得开，但**不进每日一练**，用户必须能一眼看出区别。
        """
        with self._lock:
            rows = self.conn.execute("SELECT qid, verify FROM question_provenance").fetchall()
        return {r["qid"]: r["verify"] for r in rows}

    def list_questions(self) -> list[dict]:
        """按 id 排序返回全部题目（题库视图；给 bridge 的 /api/daily 用）。"""
        with self._lock:
            rows = self.conn.execute(
                "SELECT id, kid, type, answer_type, stem, options, answer, analysis,"
                " difficulty, source FROM questions ORDER BY id"
            ).fetchall()
            return [dict(r) for r in rows]

    #: 题库浏览视图的列 —— **结构上不含 answer / analysis**（ADR-017 决策 3）。
    #: 用"列白名单"而不是"调用方记得删"：漏删是静默泄露，漏加是当场报错。
    _VIEW_COLS = "id, kid, type, answer_type, stem, options, difficulty, source"

    def list_question_views(self) -> list[dict]:
        """题库浏览用的题目行（不含答案与解析）。"""
        with self._lock:
            rows = self.conn.execute(
                f"SELECT {self._VIEW_COLS} FROM questions ORDER BY id"
            ).fetchall()
            return [dict(r) for r in rows]

    def get_question_view(self, qid: str) -> dict | None:
        """单题浏览视图（不含答案与解析）；没有则 None。"""
        with self._lock:
            row = self.conn.execute(
                f"SELECT {self._VIEW_COLS} FROM questions WHERE id = ?", (qid,)
            ).fetchone()
            return dict(row) if row else None

    def load_kp(self, rows: list[dict]) -> int:
        n = 0
        with self._lock:
            for r in rows:
                self.conn.execute(
                    "INSERT INTO kp(id, title, chapter, subject, exam, related) VALUES(?,?,?,?,?,?) "
                    "ON CONFLICT(id) DO UPDATE SET title=excluded.title, chapter=excluded.chapter,"
                    " subject=excluded.subject, exam=excluded.exam, related=excluded.related",
                    (r["id"], r.get("title"), r.get("chapter"), r.get("subject"),
                     r.get("exam"), r.get("related")),
                )
                n += 1
            self.conn.commit()
            return n

    def list_kp(self) -> list[dict]:
        """知识点目录（只读端点 `/api/kp` 的数据源；表小，一次给全）。

        为什么需要它：`attempts`/`/api/daily` 里只有 `kid`（如 `l1n1`），
        没有这张目录，agent 只能说"你在 l1n1 上错得多"，说不出人话。
        """
        with self._lock:
            return [dict(r) for r in self.conn.execute(
                "SELECT id, title, chapter, subject, exam, related FROM kp ORDER BY id"
            ).fetchall()]

    def kp_count(self) -> int:
        with self._lock:
            return int(self.conn.execute("SELECT COUNT(*) AS c FROM kp").fetchone()["c"])

    # ------------------------------------------------------------ 收尾
    def close(self) -> None:
        with self._lock:
            self.conn.close()

    def __enter__(self) -> "Store":
        return self

    def __exit__(self, *exc) -> None:
        self.close()
