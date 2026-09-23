"""scripts/rate_practiceable.py —— **可练性判定**：让语料题从 `unverified` 升级到能进练习池。

规格：`docs/DECISIONS.md` **ADR-020**（判分定位修订：agent 评分优先）· `ADR-019`（unverified 不进池那条门）。

**它解决什么**：题库里 5395 道语料题看得见、练不了 —— 因为 `verify='unverified'` 被 `/api/daily` 排除。
按 ADR-020，让 **agent 判定这道题能不能练**（题干是否完整、解答是否可用、是不是那种"没答案也能自评"的题），
通过则标 `agent_rated` ⇒ **进练习池**。

**它不做什么**（这条边界不能模糊，ADR-020 的代价 1 就是为此写的）：
  · 它**不生产标准答案**，也不冒充标准答案 —— 练习时仍走 `self_report`（用户自评）或 agent 对话评分。
  · 它是「**准入判定**」，不是「正确性证明」。

判据（每题三个布尔 + 一句人话理由，落进旁表的 `number_evidence` 之外的新列不必要 —— 复用 agent_notes 太重，
这里直接把判定写进 `question_provenance.verify` + 一条 `agent_notes(kind='practiceable')` 存理由）：
  · `stem_ok`      题干读得通、不是页眉/目录/纯讲解
  · `solution_ok`  解答存在且看得出是解答（不是半截）
  · `practiceable` 合起来：**值得放进练习池**

用法：
    python3 scripts/rate_practiceable.py --candidates data/candidates/jmdw-xiandai.hybrid.kpid.json \
        --batch 10 --concurrency 12 --apply
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

from scripts.segment_ab import DEFAULT_BASE, DEFAULT_MODEL, ask_model  # noqa: E402

__all__ = ["PROMPT", "SCHEMA", "main"]

SCHEMA = {
    "type": "object",
    "properties": {
        "ratings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "idx": {"type": "integer", "description": "题目在本次列表里的序号（从 0 开始）"},
                    "stem_ok": {"type": "boolean"},
                    "solution_ok": {"type": "boolean"},
                    "practiceable": {"type": "boolean", "description": "值得放进练习池吗"},
                    "reason": {"type": "string", "description": "一句话理由（≤30 字）"},
                },
                "required": ["idx", "stem_ok", "solution_ok", "practiceable", "reason"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["ratings"],
    "additionalProperties": False,
}

PROMPT = """你在给一个考研数学练题系统做**入库前准入判定**。下面是若干道 OCR 出来的题目（题干 + 书上的解答片段）。

请逐题判断三件事（只判断"能不能拿来练"，**不要解题、不要给答案**）：
1. `stem_ok`：题干读得通吗？（不是页眉/目录/纯知识点讲解/半截话）
2. `solution_ok`：解答存在、且看得出是这道题的解答吗？（不是半截、不是别的题的内容）
3. `practiceable`：**综合起来，值得放到练习池里给学生练吗？** 宁可严一点：
   - 题干残缺、公式乱到读不懂、明显是 OCR 噪声 ⇒ false
   - 纯证明题、纯概念辨析（没有可作答的答案）⇒ 也可以 true（学生自评/口述作答）
   - 拿不准就 false（进人工队列，不硬放进池）

⚠️ **只输出 JSON**（不要解释、不要 Markdown 代码块）：
{"ratings": [{"idx": 0, "stem_ok": true, "solution_ok": true, "practiceable": true, "reason": "题干完整"}]}

题目列表（序号 | 题干 | 解答片段）：
__ITEMS__"""


def build_prompt(batch: list[dict]) -> str:
    lines = []
    for i, q in enumerate(batch):
        stem = (q.get("stem") or "")[:220].replace("\n", " ")
        sol = (q.get("solution") or "")[:160].replace("\n", " ")
        lines.append(f"{i} | {stem} | {sol}")
    return PROMPT.replace("__ITEMS__", "\n".join(lines))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="可练性判定：agent 决定哪些语料题能进练习池")
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--batch", type=int, default=10)
    ap.add_argument("--concurrency", type=int, default=12)
    ap.add_argument("--max-output-tokens", type=int, default=32_000)
    ap.add_argument("--base-url", default=DEFAULT_BASE)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--key-env", default="OPENCODE_API_KEY")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--apply", action="store_true",
                    help="把通过判定的题写成 verify=agent_rated（不写就只是看结果）")
    ap.add_argument("--out", default=None, help="默认 <candidates>.rated.json")
    args = ap.parse_args(argv)

    src = Path(args.candidates)
    bank = json.loads(src.read_text(encoding="utf-8"))
    questions = bank["questions"]
    dest = Path(args.out) if args.out else src.with_suffix(".rated.json")
    partial = dest.with_suffix(".partial.jsonl")

    done: dict[int, dict] = {}
    if args.resume and partial.exists():
        for line in partial.read_text(encoding="utf-8").splitlines():
            if line.strip():
                row = json.loads(line)
                done[row["idx"]] = row
        print(f"续跑：已读回 {len(done)} 条判定")

    batches = [(i, questions[i:i + args.batch]) for i in range(0, len(questions), args.batch)]
    todo = [(i, b) for i, b in batches if not all((i + j) in done for j in range(len(b)))]
    key = os.environ.get(args.key_env)
    if not key:
        raise SystemExit(f"环境变量 {args.key_env} 没设置")
    if args.model != DEFAULT_MODEL:
        raise SystemExit(f"只允许用 {DEFAULT_MODEL}（决策人限定）")
    print(f"待判定 {len(todo)} 批（每批 {args.batch} 题）· 共 {len(questions)} 题")

    lock = threading.Lock()

    def do_batch(pair):
        base_idx, batch = pair
        out = ask_model(base=args.base_url, key=key, model=args.model,
                        max_output_tokens=args.max_output_tokens,
                        input_text=build_prompt(batch), schema=SCHEMA)
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
                for r in out["parsed"].get("ratings", []):
                    row = {**r, "idx": base_idx + r["idx"]}
                    done[row["idx"]] = row
                    with open(partial, "a", encoding="utf-8") as fh:
                        fh.write(json.dumps(row, ensure_ascii=False) + "\n")
                print(f"  批次 {base_idx}：已判定 {len(done)}/{len(questions)}", flush=True)

    ok = sum(1 for i in range(len(questions)) if (done.get(i) or {}).get("practiceable"))
    for i, q in enumerate(questions):
        r = done.get(i)
        q["practiceable"] = bool(r and r.get("practiceable"))
        q["practiceable_reason"] = (r or {}).get("reason")
        if args.apply:
            q["verify"] = "agent_rated" if q["practiceable"] else "unverified"
    dest.write_text(json.dumps(bank, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"\n✅ 判定完成：可练 {ok}/{len(questions)}（{round(100 * ok / max(1, len(questions)))}%）→ {dest}")
    if args.apply:
        print("   已写 verify=agent_rated（可练）/ unverified（不可练）—— 前者会进练习池")
    return 0


if __name__ == "__main__":
    sys.exit(main())
