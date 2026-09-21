"""modules/qbank/module.py —— 题库浏览（栏目 / 分类 / 题卡 / 详情）+ agent 定难度。
规格：ADR-017（只读浏览）、ADR-018（agent 写难度的唯一动作）。

三个 rpc，走 bridge **既有**的模块路由 `/m/qbank/<rpc>`（**不加端点** —— bridge 自有
端点集合仍是五个，§11.5 与 refcheck 的 C2b 都不动）：

  · `list`            → 栏目页：学科聚合 + **按章的题目类型分组** + 题目卡片列表
  · `detail`          → 详情页：题面 + 难度 + 我的作答史 + agent 复盘
  · `set_difficulty`  → **唯一的写动作**（ADR-018）：把 agent 判定的难度记一条

**难度的两条来源**（ADR-018 决策 2）：题库自带的 `questions.difficulty` 是数据管线的产物，
agent 判定另存 `agent_difficulty`（append-only，取最新）。读取时**agent 优先**：
`difficulty` = 生效值、`difficultyBase` = 题库原生、`difficultySource` = `agent` / `question`。
两者混写一列的话，重灌题库那天 agent 的判定会被静默抹掉。

四条纪律（写在这里，改代码前先读）：
  ① **只读为主**：`list`/`detail` 不写任何表、不做判定（判定一律 `core.judge`，铁律 3）；
     唯一的写动作是 `set_difficulty`，且**只写 `agent_difficulty` 一张表**。
  ② **不回答案**：题目行一律取 `store.list_question_views()` / `get_question_view()`
     —— 这两个访问器的列白名单里**根本没有 answer/analysis**（ADR-017 决策 3）。
     用结构保证，不靠"这里记得删"。
  ③ **时间降粒度到天**：与 `/api/attempts` 同口径 —— 不把"你几点在做题"发出去。
  ④ **两个指标的定义写死**（免得 UI 与后端各算一套）：
     · 完成度 `coverage` = **做过的题数 / 总题数**（做过一次就算，不重复计）
     · 综合评分 `score`  = **做对过的题数 / 总题数**（"掌握度"的口径：对过才算掌握）
     分母都是**该栏目当前题量**，都取百分比整数。
"""

from __future__ import annotations

from datetime import datetime, timezone

__all__ = ["on_request", "MAX_LIMIT", "DEFAULT_LIMIT", "DIFF_MIN", "DIFF_MAX"]

DIFF_MIN, DIFF_MAX = 1, 4        #: 难度值域（ARCHITECTURE §3.1：INT 1-4）

#: 一页最多返回多少题 —— 防止把浏览器/agent 的上下文一次塞爆（与 /api/attempts 的 limit 同理）。
MAX_LIMIT = 200
DEFAULT_LIMIT = 80


def on_request(rpc: str, payload: dict, ctx):
    """`/m/qbank/<rpc>` 的落点（`core.registry.Registry.dispatch` 调）。

    `ctx` 是 `Store`（bridge 传的），不是请求对象 —— 所以这里**拿不到请求身份**。
    这正是设计意图：本模块没有"分身份给不同数据"的需求，因为**答案对谁都不给**。
    """
    store = ctx
    payload = payload or {}
    if rpc == "list":
        return _list(store, payload)
    if rpc == "detail":
        return _detail(store, payload)
    if rpc == "set_difficulty":
        return _set_difficulty(store, payload)
    raise KeyError(f"qbank 未声明 rpc {rpc!r}")     # bridge 会转成 404 no_such_rpc


# ---------------------------------------------------------------- 工具

def _day(ts: float | None) -> str | None:
    """秒级时间戳 → 本地日历日（与 /api/attempts 的降粒度口径一致）。"""
    if not ts:
        return None
    return datetime.fromtimestamp(float(ts), tz=timezone.utc).astimezone().strftime("%Y-%m-%d")


def _pct(n: int, d: int) -> int:
    return int(round(100.0 * n / d)) if d else 0


def _kp_index(store) -> dict[str, dict]:
    return {r["id"]: r for r in store.list_kp()}


def _attempt_index(store) -> dict[str, dict]:
    """qid → {n, correct, first_ts, last_ts}（SQL 聚合，不搬全表）。"""
    return {r["qid"]: r for r in store.list_attempt_stats()}


def _note_index(store) -> dict[str, dict]:
    """qid → 最新一条复盘（按 id 递增，后者覆盖前者）。"""
    out: dict[str, dict] = {}
    for r in store.list_notes():
        out[r["qid"]] = r
    return out


def _difficulty_index(store) -> dict[str, dict]:
    """qid → **最新一条 agent 判定难度**（ADR-018）。没有条目的题 = agent 还没评过。"""
    return store.latest_difficulties()


def _verify_index(store) -> dict[str, str]:
    """qid → 验证状态（ADR-019）。没有旁表行的生成器题 = `auto_verified`（能进练习池）。"""
    return store.verify_map()


def _difficulty_fields(qid: str, base, adiff: dict[str, dict]) -> dict:
    """难度的三个字段：生效值 / 题库原生 / 来源。UI 只认 `difficulty`，另两个用来说明。"""
    row = adiff.get(qid)
    return {
        "difficulty": row["difficulty"] if row else base,          # 生效值（agent 优先）
        "difficultyBase": base,                                     # 题库自带（可能为 None）
        "difficultySource": "agent" if row else ("question" if base is not None else "none"),
        "difficultyReason": (row or {}).get("reason"),
        "difficultyDay": _day((row or {}).get("ts")),
    }


def _chapter_order(store) -> dict[str, int]:
    """章的排序权重 = 知识树里的出现顺序。

    为什么不按章名字符串排：章名是「第八章 行列式」这种中文数字，字典序会把
    「第十八章」排到「第八章」前面。`kp` 按考点 id 升序（l1n1 → l2n1 → …）正好就是树序。
    """
    order: dict[str, int] = {}
    for i, r in enumerate(store.list_kp()):
        order.setdefault(r.get("chapter") or "未归类", i)
    return order


def _limit_of(payload: dict) -> int:
    try:
        n = int(payload.get("limit", DEFAULT_LIMIT))
    except (TypeError, ValueError):
        n = DEFAULT_LIMIT
    return max(1, min(MAX_LIMIT, n))


def _bool_of(v):
    """查询串进来的是**字符串** —— `bool("false") is True`，直接用会静默把筛选反过来。

    返回 True / False / None（None = 不过滤；认不出的值一律当"不过滤"，不猜）。
    """
    if v is None or isinstance(v, bool):
        return v
    s = str(v).strip().lower()
    if s in ("1", "true", "yes", "y"):
        return True
    if s in ("0", "false", "no", "n"):
        return False
    return None


# ---------------------------------------------------------------- list

def _list(store, payload: dict) -> dict:
    subject = payload.get("subject") or None
    chapter = payload.get("chapter") or None      # 题目类型（= kp 的章，如「第八章 行列式」）
    kid = payload.get("kid") or None
    done_filter = _bool_of(payload.get("done"))           # None / True / False
    limit = _limit_of(payload)

    kp = _kp_index(store)
    stats = _attempt_index(store)
    notes = _note_index(store)
    adiff = _difficulty_index(store)
    vmap = _verify_index(store)

    items: list[dict] = []
    buckets: dict[str, dict] = {}
    chapter_buckets: dict[tuple[str, str], dict] = {}
    for q in store.list_question_views():
        node = kp.get(q.get("kid") or "", {})
        subj = node.get("subject") or "unknown"
        chap = node.get("chapter") or "未归类"
        st = stats.get(q["id"])
        n_att = int(st["n"]) if st else 0
        n_ok = int(st["correct"] or 0) if st else 0
        done = n_att > 0

        b = buckets.setdefault(subj, {"id": subj, "total": 0, "done": 0, "mastered": 0, "attempts": 0, "correct": 0})
        b["total"] += 1
        b["done"] += 1 if done else 0
        b["mastered"] += 1 if n_ok > 0 else 0
        b["attempts"] += n_att
        b["correct"] += n_ok

        cb = chapter_buckets.setdefault((subj, chap), {
            "chapter": chap, "subject": subj, "total": 0, "done": 0, "mastered": 0,
            "attempts": 0, "correct": 0, "kids": {}})
        cb["total"] += 1
        cb["done"] += 1 if done else 0
        cb["mastered"] += 1 if n_ok > 0 else 0
        cb["attempts"] += n_att
        cb["correct"] += n_ok
        cb["kids"].setdefault(node.get("id") or q.get("kid") or "未归类",
                              {"kid": node.get("id") or q.get("kid"), "title": node.get("title"), "total": 0})
        cb["kids"][node.get("id") or q.get("kid") or "未归类"]["total"] += 1

        if subject and subj != subject:
            continue
        if chapter and chap != chapter:
            continue
        if kid and q.get("kid") != kid:
            continue
        if done_filter is not None and bool(done_filter) != done:
            continue
        items.append({
            "qid": q["id"],
            "kid": q.get("kid"),
            "kidTitle": node.get("title"),
            "chapter": node.get("chapter"),
            "subject": subj,
            "type": q.get("type"),
            "answerType": q.get("answer_type"),
            **_difficulty_fields(q["id"], q.get("difficulty"), adiff),
            # 题面**给**（卡片要显示它）；答案与解析不在白名单里，结构上出不来。
            "stem": q.get("stem"),
            "done": done,
            "attempts": n_att,
            "correct": n_ok,
            "lastDay": _day(st["last_ts"]) if st else None,
            "hasNote": q["id"] in notes,
            # ADR-019：`unverified` 的语料题**看得见、不能练** —— 界面必须标出来
            "verify": vmap.get(q["id"], "auto_verified"),
            "source": q.get("source"),
        })

    subjects = []
    for b in buckets.values():
        subjects.append({
            "id": b["id"],
            "total": b["total"],
            "done": b["done"],
            "mastered": b["mastered"],
            "attempts": b["attempts"],
            "coverage": _pct(b["done"], b["total"]),
            "score": _pct(b["mastered"], b["total"]),
            "accuracy": _pct(b["correct"], b["attempts"]),
        })
    subjects.sort(key=lambda s: (-s["total"], s["id"]))

    # 「题目类型」分组：**先按知识树铺满这个学科的所有章**（含零题的章 ——
    # 它们是"这个学科还有哪些类型"的地图，也是数据还没提炼出来的空状态入口），
    # 再把有题的章的计数填进去。顺序取知识树顺序，不按章名字典序（中文数字会排乱）。
    order = _chapter_order(store)
    for r in store.list_kp():
        subj = r.get("subject") or "unknown"
        if subject and subj != subject:
            continue
        cb = chapter_buckets.setdefault((subj, r.get("chapter") or "未归类"), {
            "chapter": r.get("chapter") or "未归类", "subject": subj,
            "total": 0, "done": 0, "mastered": 0, "attempts": 0, "correct": 0, "kids": {}})
        cb["kids"].setdefault(r["id"], {"kid": r["id"], "title": r.get("title"), "total": 0})
    groups = []
    for (subj, chap), cb in chapter_buckets.items():
        if subject and subj != subject:
            continue
        groups.append({
            "chapter": chap,
            "subject": subj,
            "total": cb["total"],
            "done": cb["done"],
            "mastered": cb["mastered"],
            "coverage": _pct(cb["done"], cb["total"]),
            "score": _pct(cb["mastered"], cb["total"]),
            # ⚠️ accuracy 的口径与 subjects 一致 = **答对次数 ÷ 作答次数**，
            # 不是"做对过的题 ÷ 题量"（后者是 score）。写错过一次就被人抓到过。
            "accuracy": _pct(cb["correct"], cb["attempts"]),
            "attempts": cb["attempts"],
            "kids": sorted(cb["kids"].values(), key=lambda k: str(k["kid"])),
        })
    groups.sort(key=lambda g: (order.get(g["chapter"], 10 ** 6), g["chapter"]))

    # **做过的排前面**（`not done` ⇒ False=0 在前），同组按题号稳定排序。
    # 反着写（`i["done"]`）会把 48 张未做的卡全推到前面，做完的两张沉到列表尾部 —— 实测踩过。
    items.sort(key=lambda i: (not i["done"], i["qid"]))

    return {
        "schemaVersion": 1,
        "subjects": subjects,
        "groups": groups,
        "items": items[:limit],
        "counts": {"matched": len(items), "returned": min(len(items), limit)},
    }


# ---------------------------------------------------------------- detail

def _detail(store, payload: dict) -> dict:
    qid = (payload.get("qid") or "").strip()
    if not qid:
        raise KeyError("detail 需要 qid")
    q = store.get_question_view(qid)
    if q is None:
        raise KeyError(f"未知题目 {qid!r}")

    node = _kp_index(store).get(q.get("kid") or "", {})
    attempts = store.list_attempts(qid=qid)
    notes = store.list_notes(qid=qid)
    adiff = _difficulty_index(store)
    vmap = _verify_index(store)

    return {
        "schemaVersion": 1,
        "question": {
            "qid": q["id"],
            "kid": q.get("kid"),
            "kidTitle": node.get("title"),
            "chapter": node.get("chapter"),
            "subject": node.get("subject") or "unknown",
            "type": q.get("type"),
            "answerType": q.get("answer_type"),
            **_difficulty_fields(q["id"], q.get("difficulty"), adiff),
            "stem": q.get("stem"),
            "options": q.get("options"),
            "source": q.get("source"),
            "verify": vmap.get(q["id"], "auto_verified"),
        },
        # 作答史：只回**日粒度** + 判决，不回秒级时间戳（与 /api/attempts 同口径）
        "attempts": [
            {
                "id": a["id"],
                "day": _day(a["ts"]),
                "verdict": a["verdict"],
                "correct": bool(a["correct"]) if a["correct"] is not None else None,
            }
            for a in attempts
        ],
        "done": len(attempts) > 0,
        "correct": any(a["correct"] == 1 for a in attempts) if attempts else None,
        # agent 复盘：**谁写的、从哪来的都带出来**（"agent 说的话"必须有溯源，不能像系统事实）
        "notes": [
            {
                "id": n["id"],
                "kind": n["kind"],
                "summary": n["summary"],
                "reason": n["reason"],
                "author": n["author"],
                "src": n["src"],
                "day": _day(n["ts"]),
            }
            for n in notes
        ],
    }


# ---------------------------------------------------------------- 写：agent 定难度

def _set_difficulty(store, payload: dict) -> dict:
    """**本模块唯一的写动作**（ADR-018）：把 agent 判定的难度记一条。

    - 只写 `agent_difficulty` 一张表（append-only，取最新）；**不碰** `questions.difficulty`
      （题库原生难度是数据管线的产物，重灌时要能还原）。
    - 未知题号 → `KeyError`（bridge 转 404）；难度不在 1-4 → `ValueError`（bridge 转 400）。
    - `src` 由调用方自报（如 `dsh` / `ui` / `offline`），默认 `agent`。⚠️ 模块拿不到请求身份
      （`ctx` 只有 store），所以**这是自报不是鉴权** —— 单用户下可接受，登记在 ADR-018 代价 1。
    """
    qid = (payload.get("qid") or "").strip()
    if not qid:
        raise ValueError("set_difficulty 需要 qid")
    if store.get_question_view(qid) is None:
        raise KeyError(f"未知题目 {qid!r}")
    try:
        d = int(payload.get("difficulty"))
    except (TypeError, ValueError):
        raise ValueError(f"difficulty 必须是 {DIFF_MIN}-{DIFF_MAX} 的整数，"
                         f"收到 {payload.get('difficulty')!r}")
    if not DIFF_MIN <= d <= DIFF_MAX:
        raise ValueError(f"difficulty 必须是 {DIFF_MIN}-{DIFF_MAX}，收到 {d}")
    src = str(payload.get("src") or "agent")[:32]
    nid = store.record_difficulty(qid=qid, difficulty=d,
                                  reason=payload.get("reason"), src=src)
    return {
        "ok": True,
        "id": nid,
        "qid": qid,
        "difficulty": d,
        "difficultySource": "agent",
        "difficultyBase": store.get_question_view(qid).get("difficulty"),
        "day": _day(store.latest_difficulties().get(qid, {}).get("ts")),
    }
