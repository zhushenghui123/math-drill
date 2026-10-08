"""modules/feedback/module.py —— 报错回流（ADR-022）：把"这题有问题"变成一条**可处理的账**。

规格：`docs/DECISIONS.md` **ADR-022** · `docs/DATA_PIPELINE.md` §9（"练习界面「报错」按钮"是被列入
**必需保留**的那一条）· `core/store.py` 的 `question_reports`（`schema_version = 7`）。

**它在整条管线里的位置**：OCR 语料难免有噪声（页眉并进正文、解答被截断、表格揉成一行……），
而"懒惰纠正"路线的命门就是**得先知道哪道题坏了**。此前的发现路径只有"做到那道题时人工察觉"，
报错按钮把它变成**一键落账**：`qid + 原因 + 谁报的 + 时间` ⇒ 之后无论是人工清洗还是再跑一遍
prompt 修，都有了输入。

**边界（与 ADR-019 一致）**：
  · **旁表**，不给 `questions` 加列 —— 报错是"使用中产生的信号"，不是题库的固有属性；
  · 本模块**不改题面**、也不判对错，只记账（改动题面属数据管线，得走重灌那条路）；
  · 原因用**白名单**（`KINDS`）而不是自由文本 —— 自由文本另存 `note`，只作补充。

身份：`ctx` 是被 bridge 包过的 `UserScopedStore`，但**用户 id 不在 store 里** ——
bridge 在分发前把它写进 `payload["_user"]`（保留键，客户端传的同名值会被覆盖）。
"""

from __future__ import annotations

__all__ = ["KINDS", "MAX_NOTE", "on_request"]

#: 报错原因白名单：键进库、值给人看（前端按钮与这里保持同一套键）
KINDS = {
    "stem": "题干有误（缺字/多字/串题）",
    "answer": "答案或解析有误",
    "ocr": "OCR 噪声（页眉/水印/表格碎片）",
    "other": "其它（见备注）",
}

#: 备注长度上限：够说明问题，又不至于把队列撑爆（超长直接 400，不静默截断）
MAX_NOTE = 500


def on_request(rpc: str, payload: dict, ctx):
    """`/m/feedback/<rpc>` 的落点（`core.registry.Registry.dispatch` 调）。"""
    store = ctx
    payload = payload or {}
    if rpc == "file":
        return _file(store, payload)
    if rpc == "list":
        return _list(store, payload)
    raise KeyError(f"feedback 未声明 rpc {rpc!r}")      # bridge 转 404 no_such_rpc


def _file(store, payload: dict) -> dict:
    """写一条报错。**校验从严**：题必须存在、原因必须在白名单、备注有上限。"""
    qid = payload.get("qid")
    kind = payload.get("kind")
    note = payload.get("note")
    if not isinstance(qid, str) or not qid:
        raise ValueError("需要 qid（字符串）")                     # → 400
    if kind not in KINDS:
        raise ValueError(f"kind 必须是 {sorted(KINDS)} 之一")      # → 400
    if note is not None:
        if not isinstance(note, str):
            raise ValueError("note 必须是字符串")
        if len(note) > MAX_NOTE:
            raise ValueError(f"note 最多 {MAX_NOTE} 字")
    if store.get_question(qid) is None:
        raise KeyError(f"题库没有 {qid}")                          # → 404

    user = str(payload.get("_user") or "owner")     # bridge 注入（保留键，客户端同名值被覆盖）
    row_id = store.record_report(qid=qid, kind=kind, note=note, user=user)
    return {"ok": True, "id": row_id, "qid": qid, "kind": kind, "status": "open"}


def _list(store, payload: dict) -> dict:
    """看队列（默认未处理）。限额上限防"把整个队列塞进上下文"。"""
    status = payload.get("status") or "open"
    if status not in ("open", "done", "ignored"):
        raise ValueError("status 只能是 open / done / ignored")
    try:
        limit = min(int(payload.get("limit") or 50), 200)
    except (TypeError, ValueError):
        raise ValueError("limit 必须是整数") from None
    rows = store.list_reports(status=status, limit=limit)
    return {"status": status, "kinds": KINDS, "n": len(rows), "reports": rows}
