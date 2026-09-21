"""scripts/normalize_candidates.py —— 候选产物的**确定性归一化**（不调模型）。

为什么需要它（实测两处，都不是模型错）：
  1. **同济的书用 `*` 标难题**（`*10. 利用泰勒公式求下列极限:`）。切题档的锚点正则没算这个前缀 ⇒
     那些题在产物里成了 `number="*10"`、`number_source="inferred"`，而它其实**在原位清晰可读**。
  2. **浙大的题号是"章.题序"形态**，模型很自然地回 `"1.32"`（章 1、题 32），而锚点标签只有 `"32"`
     ⇒ 字符串不比配就全落 `inferred`（实测 204/311，占 66%）。

本脚本按**尾部题序**把两者对齐，并把 `number` 规范成锚点标签；`qid` 不动（已落库的 id 不能改，
改了就等于把题换了一遍）。纯机械、可复跑、零成本。

用法：
    python3 scripts/normalize_candidates.py --candidates data/candidates/zheda-quanjie.hybrid.json
    # 就地改写（先备份 .pre-normalize.json）
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from scripts.segment_corpus import PROFILES  # noqa: E402
from scripts.segment_hybrid import load_blocks, loose_anchors  # noqa: E402

__all__ = ["normalize", "main"]

TRAILING_INT = re.compile(r"(\d{1,4})\s*$")


def normalize(bank: dict, anchors_by_gid: dict[int, dict]) -> dict:
    """把 `inferred` 里"其实原位可读"的题号修回 `ocr`，并把 number 规范成锚点标签。"""
    fixed = 0
    for q in bank["questions"]:
        if q.get("number_source") != "inferred":
            # 即便标着 ocr，也顺带规范一次（`*10` → `10`）
            m = TRAILING_INT.search(str(q["number"]))
            if m and str(q["number"]) != m.group(1):
                q["number"] = m.group(1)
            continue
        # 在本题的块里找锚点：先精确比，再按"尾部题序"比
        gids = (q.get("provenance") or {}).get("blocks") or []
        hit = None
        for g in gids:
            a = anchors_by_gid.get(g)
            if a and str(a["number"]) == str(q["number"]):
                hit = a
                break
        if hit is None:
            m = TRAILING_INT.search(str(q["number"]))
            want = m.group(1) if m else None
            for g in gids:
                a = anchors_by_gid.get(g)
                if a and want is not None and str(a["number"]) == want:
                    hit = a
                    break
        if hit is not None:
            q["number"] = str(hit["number"])
            q["number_source"] = hit["source"]
            q["number_evidence"] = {"raw": hit["raw"], "span": [hit["page"], hit["idx"]],
                                    "neighbors": hit.get("neighbors"),
                                    "normalized_from": str(q.get("number"))}
            fixed += 1
    bank.setdefault("report", {})["normalized_inferred_to_ocr"] = fixed
    return bank


def reidentify(bank: dict, profile: dict) -> int:
    """**给"逐章/节内重算"的书重建唯一 qid**（必须做，否则会静默丢题）。

    实测事故：同济全解上册产出 756 题、进库只剩 645 —— 因为兜底 qid 用了 `q{题号}`，
    而这本书的题号是**节内重算**的（习题1-1 与 习题1-2 都有 `1. 2. 3.`）⇒ 主键冲突，
    upsert 把后来的覆盖掉。**丢的 111 题完全没有报错**。

    修法：qid 一律用**阅读序**（按首块的 gid 排序后编号），与题号体系解耦；
    书自己的题号留在 `number` 与 `number_evidence` 里。只对 `chapter_scoped` 的书重建。
    """
    if profile.get("number_kind") != "chapter_scoped":
        return 0
    qs = sorted(bank["questions"], key=lambda q: min(
        ((q.get("provenance") or {}).get("blocks") or [10 ** 9])))
    for i, q in enumerate(qs, 1):
        q["qid"] = f"imp.{bank['bank']}.s{i:04d}"
    bank.setdefault("report", {})["reidentified_scoped_qids"] = len(qs)
    return len(qs)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="候选产物归一化（题号尾部匹配 + 剥星号）")
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--corpus", default="~/Documents/数学数据集")
    args = ap.parse_args(argv)

    src = Path(args.candidates)
    bank = json.loads(src.read_text(encoding="utf-8"))
    book = bank["bank"]
    lo, hi = (bank.get("page_range") or [0, 500])
    blocks, _ = load_blocks(Path(args.corpus).expanduser(), book, lo, hi)
    profile = PROFILES[book]
    anchors = [{"gid": b["gid"], "page": b["page"], "idx": b["idx"],
                "number": n, "raw": raw, "source": kind}
               for b in blocks for (n, raw, kind) in loose_anchors(b["text"], profile, b["type"])]
    before = (bank.get("report") or {}).get("number_source_counts") or {}
    bank = normalize(bank, {a["gid"]: a for a in anchors})
    reidentified = reidentify(bank, profile)

    backup = src.with_suffix(".pre-normalize.json")
    if not backup.exists():
        shutil.copy2(src, backup)
    src.write_text(json.dumps(bank, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    after = {}
    for q in bank["questions"]:
        after[q["number_source"]] = after.get(q["number_source"], 0) + 1
    print(f"✅ {book}：归一化 {bank['report'].get('normalized_inferred_to_ocr', 0)} 题")
    print(f"   重建唯一 qid（节内重算的书）：{reidentified} 题"
          + ("（防止主键冲突静默丢题）" if reidentified else ""))
    print(f"   题号来源 前：{before}")
    print(f"   题号来源 后：{after}")
    print(f"   备份：{backup}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
