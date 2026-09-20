"""modules/qbank/module.py —— 题库浏览（栏目 / 题卡 / 详情）。规格：ADR-017。

两个 rpc，走 bridge **既有**的模块路由 `/m/qbank/<rpc>`（**不加端点** —— bridge 自有
端点集合仍是五个，§11.5 与 refcheck 的 C2b 都不动）：

  · `list`   → 栏目页：按学科聚合的完成度/评分 + 该学科的题目卡片列表
  · `detail` → 详情页：题面 + 难度 + 我的作答史 + agent 复盘

四条纪律（写在这里，改代码前先读）：
  ① **只读**：不写任何表、不做判定（判定一律 `core.judge`，铁律 3）。
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

__all__ = ["on_request", "MAX_LIMIT", "DEFAULT_LIMIT"]

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
    kid = payload.get("kid") or None
    done_filter = _bool_of(payload.get("done"))           # None / True / False
    limit = _limit_of(payload)

    kp = _kp_index(store)
    stats = _attempt_index(store)
    notes = _note_index(store)

    items: list[dict] = []
    buckets: dict[str, dict] = {}
    for q in store.list_question_views():
        node = kp.get(q.get("kid") or "", {})
        subj = node.get("subject") or "unknown"
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

        if subject and subj != subject:
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
            "difficulty": q.get("difficulty"),
            "done": done,
            "attempts": n_att,
            "correct": n_ok,
            "lastDay": _day(st["last_ts"]) if st else None,
            "hasNote": q["id"] in notes,
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
    items.sort(key=lambda i: (i["done"], i["qid"]))

    return {
        "schemaVersion": 1,
        "subjects": subjects,
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
            "difficulty": q.get("difficulty"),
            "stem": q.get("stem"),
            "options": q.get("options"),
            "source": q.get("source"),
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
