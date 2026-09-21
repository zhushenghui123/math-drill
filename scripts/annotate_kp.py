"""scripts/annotate_kp.py —— 数据管线 **④ annotate（知识点标注）**：把语料题标进 68 考点词表。

规格：`docs/DATA_PIPELINE.md` §1（④ 是 LLM **唯一**允许出现的地方之一）· §5（受控词表 = 知识树）
      · `contracts/corpus_segment.md`（产物字段）· `docs/DECISIONS.md` ADR-019 决策 4。

纪律：
  · **受控词表**：只能从 `web/js/data-knowledge.js` 解析出的 68 个 kid 里挑（`scripts/db_init.parse_kp_js`），
    模型给出表外的 id 一律判无效并记 `kid_invalid`，**不猜、不新增考点**。
  · **带置信度**：`kid_confidence` 与 `kid_source=llm` 一起入库；低置信度进审校（复用 ADR-019 代价 4 的分流）。
  · **可续跑**：每窗落 `.partial.jsonl`（长任务第一条纪律），`--resume` 接着跑。
  · **并发**：窗口之间独立、瓶颈是 API 延时 ⇒ `--concurrency` 直接提墙钟速度。

用法：
    python3 scripts/annotate_kp.py --candidates data/candidates/jmdw-gaoshu.hybrid.json --concurrency 12
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from scripts.db_init import parse_kp_js  # noqa: E402
from scripts.segment_ab import DEFAULT_BASE, DEFAULT_MODEL, ask_model  # noqa: E402

__all__ = ["build_prompt", "main"]

#: 标注用的 schema：**只允许回 kid 与置信度**（题目身份用序号回指，避免模型重写题号）
SCHEMA = {
    "type": "object",
    "properties": {
        "assignments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "idx": {"type": "integer", "description": "题目在本次列表里的序号（从 0 开始）"},
                    "kid": {"type": "string", "description": "必须是给定词表里的 id；拿不准就填 unknown"},
                    "confidence": {"type": "number", "description": "0-1"},
                },
                "required": ["idx", "kid", "confidence"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["assignments"],
    "additionalProperties": False,
}

PROMPT = """你是考研数学教研。下面给你一份**受控考点词表**（只能从里面挑），以及一批题目。
请为每道题挑出**最贴切的一个**考点 id，并给出 0-1 的置信度。

规则：
- `kid` 必须是词表里出现过的 id；一道题只能给一个；确实判断不了就填 `unknown`（不要硬猜）。
- 只看题干判断；证明题、综合题若横跨多个考点，选**主要考查**的那个。
- 置信度要诚实：题目信息不足、或同时像两个考点，就给低分。

⚠️ **只输出 JSON**（不要解释、不要 Markdown 代码块）：
{"assignments": [{"idx": 0, "kid": "c1n2", "confidence": 0.8}]}

受控考点词表（id | 章 | 考点名）：
__KP__

题目列表（序号 | 题干）：
__QUESTIONS__"""


def build_prompt(kp_rows: list[dict], batch: list[dict]) -> str:
    kp_text = "\n".join(f"{r['id']} | {r.get('chapter') or ''} | {r['title']}" for r in kp_rows)
    q_text = "\n".join(f"{i} | {(q['stem'] or '')[:180]}".replace("\n", " ")
                       for i, q in enumerate(batch))
    return PROMPT.replace("__KP__", kp_text).replace("__QUESTIONS__", q_text)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="④ annotate：语料题 → 68 考点词表")
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--kp-js", default=str(REPO / "web" / "js" / "data-knowledge.js"))
    ap.add_argument("--batch", type=int, default=20, help="每窗多少题")
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--max-output-tokens", type=int, default=32_000)
    ap.add_argument("--base-url", default=DEFAULT_BASE)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--key-env", default="OPENCODE_API_KEY")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--out", default=None, help="默认写回 <candidates>.kpid.json")
    args = ap.parse_args(argv)

    src = Path(args.candidates)
    bank = json.loads(src.read_text(encoding="utf-8"))
    questions = bank["questions"]
    kp_rows = parse_kp_js(Path(args.kp_js))
    valid = {r["id"] for r in kp_rows}
    dest = Path(args.out) if args.out else src.with_suffix(".kpid.json")
    partial = dest.with_suffix(".partial.jsonl")

    done: dict[int, dict] = {}
    if args.resume and partial.exists():
        for line in partial.read_text(encoding="utf-8").splitlines():
            if line.strip():
                row = json.loads(line)
                done[row["idx"]] = row
        print(f"续跑：已读回 {len(done)} 题标注")

    batches = [(i, questions[i:i + args.batch]) for i in range(0, len(questions), args.batch)]
    todo = [(i, b) for i, b in batches if not all((i + j) in done for j in range(len(b)))]
    key = os.environ.get(args.key_env)
    if not key:
        raise SystemExit(f"环境变量 {args.key_env} 没设置")
    if args.model != DEFAULT_MODEL:
        raise SystemExit(f"只允许用 {DEFAULT_MODEL}")

    lock = threading.Lock()
    invalid = 0

    def do_batch(pair):
        base_idx, batch = pair
        out = ask_model(base=args.base_url, key=key, model=args.model,
                        max_output_tokens=args.max_output_tokens,
                        input_text=build_prompt(kp_rows, batch), schema=SCHEMA)
        return base_idx, out

    with ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as pool:
        futures = {pool.submit(do_batch, p): p for p in todo}
        for fut in as_completed(futures):
            try:
                base_idx, out = fut.result()
            except SystemExit as exc:
                print(f"  ⚠️ 批次 {futures[fut][0]} 失败：{str(exc)[:90]}", flush=True)
                continue
            with lock:
                for a in out["parsed"].get("assignments", []):
                    kid = a["kid"] if a["kid"] in valid else "unknown"
                    if kid == "unknown":
                        invalid += 1
                    row = {"idx": base_idx + a["idx"], "kid": kid,
                           "kid_confidence": a["confidence"], "kid_source": "llm"}
                    done[row["idx"]] = row
                    with open(partial, "a", encoding="utf-8") as fh:
                        fh.write(json.dumps(row, ensure_ascii=False) + "\n")
                print(f"  批次 {base_idx}：已标 {len(done)}/{len(questions)}", flush=True)

    for i, q in enumerate(questions):
        row = done.get(i)
        q["kid"] = row["kid"] if row else None
        q["kid_confidence"] = row["kid_confidence"] if row else None
        q["kid_source"] = "llm" if row else None
    dest.write_text(json.dumps(bank, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    known = sum(1 for q in questions if q.get("kid") and q["kid"] != "unknown")
    print(f"\n✅ 标注完成：{known}/{len(questions)} 题拿到考点（unknown/无效 {invalid}）→ {dest}")
    from collections import Counter
    print("  考点分布 top10：", Counter(q["kid"] for q in questions if q.get("kid")).most_common(10))
    return 0


if __name__ == "__main__":
    sys.exit(main())
