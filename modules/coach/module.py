"""modules/coach/module.py —— agent 复盘/评分**写回**（ADR-023，落地 ADR-020 决策 1 的 agent 路径）。

**它填的是哪个坑**：ADR-020 定了"两条评分路径并存"——机器判定走 `core/judge`，
**agent 评分**另存 `agent_notes`（`kind='grade'`）——但那条路**一直没有写入口**：
agent 在 DSH 里把复盘说完，话就散了，控制台的详情页永远是"暂无复盘"。

**红线怎么守的**（ADR-023 逐条）：
  · 落 **`agent_notes` 旁表**、带 `user_id` —— **不进 blob**（ADR-002 的单写者纪律不破）、
    也不冒充标准答案（`answer_type` 一个字没碰；它是**辅导性反馈**，不是判分依据，ADR-013/020）；
  · 类型白名单 `grade` / `review`，都属于**个人类**（`PERSONAL_NOTE_KINDS`）⇒ 只有本人看得到；
  · 篇幅有上限（`summary` ≤ 500、`reason` ≤ 500）：agent 的上下文预算与"队列可读性"都靠它；
  · `attempt_id` 给了就校验**它属于这个人**（防张冠李戴）。

身份：同 feedback —— bridge 在分发前把"当前是谁"写进保留键 `payload["_user"]`。
"""

from __future__ import annotations

__all__ = ["KINDS", "MAX_SUMMARY", "MAX_REASON", "on_request"]

#: 允许写回的两类（键进库、值给人看）。**故意不含 `practiceable`** —— 那个是数据管线的准入判定。
KINDS = {
    "grade": "agent 评分（对本人这次作答的评语）",
    "review": "agent 复盘（讲解 / 提醒 / 下一步建议）",
}

MAX_SUMMARY = 500
MAX_REASON = 500


def on_request(rpc: str, payload: dict, ctx):
    """`/m/coach/<rpc>` 的落点。"""
    store = ctx
    payload = payload or {}
    if rpc == "note":
        return _note(store, payload)
    if rpc == "list":
        return _list(store, payload)
    raise KeyError(f"coach 未声明 rpc {rpc!r}")      # bridge 转 404


def _text(value, *, name: str, limit: int, required: bool) -> str | None:
    if value is None:
        if required:
            raise ValueError(f"需要 {name}")
        return None
    if not isinstance(value, str):
        raise ValueError(f"{name} 必须是字符串")
    value = value.strip()
    if required and not value:
        raise ValueError(f"{name} 不能为空")
    if len(value) > limit:
        raise ValueError(f"{name} 最多 {limit} 字")
    return value or None


def _note(store, payload: dict) -> dict:
    """写一条复盘/评分。校验从严：题存在、类型白名单、篇幅上限、attempt 归属。"""
    qid = payload.get("qid")
    if not isinstance(qid, str) or not qid:
        raise ValueError("需要 qid（字符串）")
    kind = payload.get("kind")
    if kind not in KINDS:
        raise ValueError(f"kind 必须是 {sorted(KINDS)} 之一（数据管线的 practiceable 不在其列）")
    summary = _text(payload.get("summary"), name="summary", limit=MAX_SUMMARY, required=True)
    reason = _text(payload.get("reason"), name="reason", limit=MAX_REASON, required=False)
    if store.get_question(qid) is None:
        raise KeyError(f"题库没有 {qid}")

    user = str(payload.get("_user") or "owner")
    attempt_id = payload.get("attempt_id")
    if attempt_id is not None:
        if not isinstance(attempt_id, int):
            raise ValueError("attempt_id 必须是整数")
        row = store.conn.execute("SELECT user_id FROM attempts WHERE id = ?", (attempt_id,)).fetchone()
        if row is None:
            raise KeyError(f"没有 id={attempt_id} 的作答记录")
        if (row["user_id"] or "owner") != user:
            raise ValueError("attempt_id 不属于当前用户（不许给别人的作答写评语）")

    note_id = store.record_note(qid=qid, kind=kind, summary=summary, reason=reason,
                               author="agent", src="agent:coach",
                               attempt_id=attempt_id, user=user)
    return {"ok": True, "id": note_id, "qid": qid, "kind": kind, "user": user}


def _list(store, payload: dict) -> dict:
    """按题读回（**按人过滤**由 store 的 `list_notes(user=…)` 保证）。"""
    qid = payload.get("qid")
    if qid is not None and not isinstance(qid, str):
        raise ValueError("qid 必须是字符串")
    user = str(payload.get("_user") or "owner")
    rows = store.list_notes(qid=qid, user=user)
    return {"kinds": KINDS, "n": len(rows), "notes": rows}
