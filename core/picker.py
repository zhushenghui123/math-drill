"""core/picker.py —— 每日选题算法（纯函数，无 IO）。

**为什么在 core 而不是 `modules/picker/`**：依赖矩阵（ARCHITECTURE §11.4.1 / test_dep_rules）
禁止 **bridge → modules** —— bridge 是传输层，模块靠 registry 插拔；而 `/api/daily` 的取数层
必须能直接选题目，所以算法落在 core，模块那边只做再导出（将来给 picker 开 rpc 时，
模块仍是它对外的门面，见 `modules/picker/module.py`）。
"""

from __future__ import annotations

import hashlib
from datetime import date

#: 复习额度占每日题单的比例（错过的题回炉）；其余额度给"没做过"的题。
REVIEW_RATIO = 0.25

__all__ = ["REVIEW_RATIO", "pick", "chapter_of"]


def _seed(today: date, salt: str) -> int:
    """按日期取确定性伪随机数（**不是随机**：同一天同一 salt 恒等）。"""
    return int(hashlib.sha1(f"{today.isoformat()}|{salt}".encode("utf-8")).hexdigest()[:8], 16)


def chapter_of(row: dict, kp: dict) -> str:
    """题目所属的「题目类型」（= kp 的章；查不到就落「未归类」）。"""
    node = kp.get(row.get("kid") or "") or {}
    return node.get("chapter") or "未归类"


def _kind(row: dict, stats: dict) -> str:
    """这道题对**这个人**来说是哪种：没做过 / 做错过（从没做对）/ 做对过。"""
    st = stats.get(row.get("id")) or {}
    n = int(st.get("n") or 0)
    ok = int(st.get("correct") or 0)
    if n == 0:
        return "new"
    return "wrong" if ok == 0 else "ok"


def pick(rows: list[dict], *, stats: dict, kp: dict, limit: int = 8,
         today: date | None = None, tau_days: int = 10) -> list[dict]:
    """选出**当天题单**（返回被选中的行，顺序即题单顺序）。

    rows  : `Store.practice_pool()` 的行（至少含 `id` / `kid`）
    stats : `{qid: {"n", "correct", "last_ts"}}`（`list_attempt_stats()` 的产物；**按用户过滤后**传进来）
    kp    : `{kid: {"chapter", "subject"}}`（把 kid 翻成人话）
    """
    today = today or date.today()
    if limit <= 0 or not rows:
        return []

    # 1) 按章分桶（桶内顺序稍后按日期打散）
    buckets: dict[str, list[dict]] = {}
    for r in rows:
        buckets.setdefault(chapter_of(r, kp), []).append(r)

    # 2) 章的顺序按日期打散（否则"第一个章"永远先出）
    order = sorted(buckets, key=lambda name: _seed(today, f"chapter|{name}"))

    # 3) 每章内部按 kind 分三队，队内按日期打散
    groups: dict[str, dict[str, list[dict]]] = {}
    for name in order:
        g: dict[str, list[dict]] = {"new": [], "wrong": [], "ok": []}
        for r in buckets[name]:
            g[_kind(r, stats)].append(r)
        for k in g:
            g[k].sort(key=lambda r: _seed(today, f"{name}|{k}|{r['id']}"))
        groups[name] = g
    ptr = {name: {"new": 0, "wrong": 0, "ok": 0} for name in order}

    def take(name: str, kinds: tuple[str, ...]) -> dict | None:
        for k in kinds:
            g, i = groups[name][k], ptr[name][k]
            if i < len(g):
                ptr[name][k] = i + 1
                return g[i]
        return None

    review_quota = max(0, round(limit * REVIEW_RATIO))
    picked: list[dict] = []
    wrong_count = 0

    # 4) 跨章轮转：先"新题"；复习额度没满时也允许"错题回炉"
    while len(picked) < limit:
        progressed = False
        kinds = ("new",) if wrong_count >= review_quota else ("new", "wrong")
        for name in order:
            if len(picked) >= limit:
                break
            r = take(name, kinds)
            if r is None:
                continue
            picked.append(r)
            progressed = True
            if _kind(r, stats) == "wrong":
                wrong_count += 1
        if progressed:
            continue
        # 5) 新题/错题都取完 ⇒ 用"做对过的"补位（池子小时不交白卷）
        for name in order:
            if len(picked) >= limit:
                break
            r = take(name, ("ok",))
            if r is not None:
                picked.append(r)
                progressed = True
        if not progressed:
            break

    return picked
