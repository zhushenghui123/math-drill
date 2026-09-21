"""scripts/import_candidates.py —— 把 ② 段候选（含 ④ 标注）**灌进控制台库**。

规格：`contracts/corpus_segment.md`（产物契约）· `docs/DECISIONS.md` **ADR-019**（落表与门）。

三条硬规矩（都是 ADR-019 定的，改之前先读那一条）：
  1. **`questions` 表不加列**：出处/题号来源/验证状态进**旁表 `question_provenance`**。
  2. **答案一律 `answer_type = "self_report"`**：书上的"解答"是人读的过程，不是机器可判的值；
     它落 `analysis`（解析），**不假装**成标准答案（要变成可判答案得走 ADR-013 的 CAS-first）。
  3. **`verify = unverified`**：这类题**能看见、不能练**（`Store.practice_pool()` 会把它们排除在
     `/api/daily` 之外）—— 这是 `DATA_PIPELINE §2` 的机器化，不是建议。

用法：
    python3 scripts/import_candidates.py --candidates data/candidates/jmdw-gaoshu.hybrid.kpid.json \
        --data-dir ~/math-drill-dev/data
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from core.store import Store  # noqa: E402

__all__ = ["build_rows", "SELF_REPORT_PLACEHOLDER", "main"]

#: 自评题的占位答案（`questions.answer` 是 NOT NULL）：**明确写着"这不是标准答案"**，
#: 免得将来有人把它当成判分依据（ADR-019 决策 3 的显式降级）。
SELF_REPORT_PLACEHOLDER = "（语料题·自评；标准答案待 CAS 对拍，见解析）"


def build_rows(bank: dict) -> tuple[list[dict], list[dict]]:
    """候选 → (questions 行, 旁表行)。纯函数，方便测试。"""
    q_rows, p_rows = [], []
    for q in bank["questions"]:
        prov = q.get("provenance") or {}
        src = f"ocr:{bank['bank']}"
        if prov.get("page_idx") is not None:
            src += f" p{prov['page_idx']}"
        kid = q.get("kid")
        q_rows.append({
            "id": q["qid"],
            "bundle_version": None,
            "kid": kid if kid not in (None, "unknown") else None,
            "type": "blank",
            "answer_type": "self_report",
            "stem": q["stem"],
            "options": None,
            "answer": SELF_REPORT_PLACEHOLDER,
            "analysis": q.get("solution") or None,
            "difficulty": None,           # 题库原生难度：书里没有 ⇒ 空着，等 agent 标（ADR-018）
            "gen_params": None,
            "source": src,
        })
        p_rows.append({
            "qid": q["qid"],
            "bank": bank["bank"],
            "book_title": bank.get("book_title"),
            "page_idx": prov.get("page_idx"),
            "bbox": json.dumps(prov.get("bbox"), ensure_ascii=False),
            "blocks": json.dumps(prov.get("blocks"), ensure_ascii=False),
            "number_source": q.get("number_source") or "ocr",
            "number_evidence": json.dumps(q.get("number_evidence"), ensure_ascii=False),
            "verify": q.get("verify") or "unverified",
            "segment_schema": bank.get("schema_version", 1),
            "whitelist_version": (bank.get("report") or {}).get("whitelist_version"),
        })
    return q_rows, p_rows


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="语料候选 → 控制台库（questions + question_provenance）")
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--data-dir", required=True,
                    help="**必填**：绝不允许默认写到生产库（本 thread 的教训之一）")
    args = ap.parse_args(argv)

    bank = json.loads(Path(args.candidates).read_text(encoding="utf-8"))
    q_rows, p_rows = build_rows(bank)
    store = Store(args.data_dir)
    n_q = store.load_questions(q_rows)
    n_p = store.record_provenance(p_rows)
    print(f"✅ 入库：questions {n_q} 行 · question_provenance {n_p} 行 → {args.data_dir}")
    counts = {s: sum(1 for r in p_rows if r["number_source"] == s) for s in ("ocr", "corrupted", "inferred")}
    print(f"   题号来源：{counts}")
    verify_counts = {s: sum(1 for r in p_rows if r["verify"] == s) for s in {r["verify"] for r in p_rows}}
    print(f"   验证状态：{verify_counts}")
    print(f"   考点：{sum(1 for r in q_rows if r['kid'])} 题有 kid · "
          f"{sum(1 for r in q_rows if not r['kid'])} 题未标（栏目里落「未归类」）")
    print(f"   练习池（排除 unverified）{len(store.practice_pool())} 题 · 题库可见 {store.question_count()} 题")
    store.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
