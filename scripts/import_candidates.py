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


#: agent 判定难度的合法值域（真值在 ADR-018 决策 4 与 `modules/qbank` 的 DIFF_MIN/DIFF_MAX）
DIFF_MIN, DIFF_MAX = 1, 4


def _record_agent_difficulty(store, bank: dict) -> int:
    """把候选里的 `agent_difficulty` 写进 **append-only** 的 `agent_difficulty` 表（ADR-018）。

    ⚠️ **必须幂等**：那张表是 append-only、读取取最新一条 ⇒ 若每次灌库都无条件追加，
    重复跑一次就会多出一整套"难度被改过"的假历史（数值虽不变，账本被污染）。
    故这里先取每人/每题的最新值，**只在不同才写**。
    """
    latest: dict[str, int] = {}
    for r in store.conn.execute(
        "SELECT qid, difficulty FROM agent_difficulty WHERE id IN "
        "(SELECT MAX(id) FROM agent_difficulty GROUP BY qid)"
    ):
        latest[r["qid"]] = r["difficulty"]
    n = 0
    for q in bank["questions"]:
        d = q.get("agent_difficulty")
        if not isinstance(d, int) or not (DIFF_MIN <= d <= DIFF_MAX):
            continue                      # 没有/越界的一律不写（越界由 ADR-018 兜：模块侧会 400）
        if latest.get(q["qid"]) == d:
            continue                      # 与最新一条相同 ⇒ 不重复追加
        store.record_difficulty(qid=q["qid"], difficulty=d,
                                reason=q.get("agent_difficulty_reason"),
                                author="agent", src="offline:rate_practiceable")
        n += 1
    return n

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
    n_d = _record_agent_difficulty(store, bank)
    print(f"✅ 入库：questions {n_q} 行 · question_provenance {n_p} 行 · agent 难度 {n_d} 条 → {args.data_dir}")
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
