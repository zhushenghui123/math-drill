"""scripts/rate_practiceable.py —— **可练性判定**：让语料题从 `unverified` 升级到能进练习池。

规格：`docs/DECISIONS.md` **ADR-020**（判分定位修订：agent 评分优先）· `ADR-019`（unverified 不进池那条门）。

**它解决什么**：题库里 5395 道语料题看得见、练不了 —— 因为 `verify='unverified'` 被 `/api/daily` 排除。
按 ADR-020，让 **agent 判定这道题能不能练**（题干是否完整、解答是否可用、是不是那种"没答案也能自评"的题），
通过则标 `agent_rated` ⇒ **进练习池**。

**它不做什么**（这条边界不能模糊，ADR-020 的代价 1 就是为此写的）：
  · 它**不生产标准答案**，也不冒充标准答案 —— 练习时仍走 `self_report`（用户自评）或 agent 对话评分。
  · 它是「**准入判定**」，不是「正确性证明」。

判据（每题三个布尔 + 难度 1-4 + 理由；不落旁表新列 —— 判定写 `verify`，理由随候选文件留档）：
  · `stem_ok`      题干读得通、不是页眉/目录/纯讲解
  · `solution_ok`  解答存在且看得出是解答（不是半截）
  · `practiceable` 合起来：**值得放进练习池**（写进 `verify`：agent_rated / unverified）
  · `difficulty`   **1-4 的整数**（ADR-018 决策 4 的值域；UI 标签：入门/基础/进阶/挑战）+
                   `difficulty_reason`，写候选文件的 `agent_difficulty[_reason]`
                   （进 `agent_difficulty` 表待入库步骤 —— 本脚本只写候选文件）

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
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from scripts.segment_ab import ALLOWED_MODELS, DEFAULT_BASE, DEFAULT_MODEL, ask_model  # noqa: E402

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
                    "difficulty": {"type": "integer",
                                   "description": "考研难度 1-4（1=入门，2=基础，3=进阶，4=挑战）"},
                    "difficulty_reason": {"type": "string",
                                          "description": "难度依据（≤30 字，如'两步凑配'）"},
                    "reason": {"type": "string", "description": "一句话理由（≤30 字）"},
                },
                "required": ["idx", "stem_ok", "solution_ok", "practiceable",
                             "difficulty", "difficulty_reason", "reason"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["ratings"],
    "additionalProperties": False,
}

PROMPT = """你在给一个考研数学练题系统做**入库前准入判定**。下面是若干道 OCR 出来的题目（题干 + 书上的解答片段）。

请逐题判断以下几件事（只判断"能不能拿来练 / 多难"，**不要解题、不要给答案**）：
1. `stem_ok`：题干读得通吗？（不是页眉/目录/纯知识点讲解/半截话）
2. `solution_ok`：解答存在、且看得出是这道题的解答吗？（不是半截、不是别的题的内容）
3. `practiceable`：**综合起来，值得放到练习池里给学生练吗？** 宁可严一点：
   - 题干残缺、公式乱到读不懂、明显是 OCR 噪声 ⇒ false
   - 纯证明题、纯概念辨析（没有可作答的答案）⇒ 也可以 true（学生自评/口述作答）
   - 拿不准就 false（进人工队列，不硬放进池）
4. `difficulty`：**这道题在考研里的难度，1-4 的整数**（按题目本身的思维量与计算量，不按 OCR 质量；值域就是 1-4，没有 5）：
   - 1 = 入门（套公式就完事）；2 = 基础（常规课后题）；3 = 进阶（考研常规大题水平）；
   - 4 = 挑战（需要两三个知识点串联 / 压轴 / 综合题）。
   ⚠️ 这一项**即使 `practiceable=false` 也要给**（题能不能练，跟它多难是两件事）。
5. `difficulty_reason`：一句话说清难度的依据（≤30 字）。

⚠️ **只输出 JSON**（不要解释、不要 Markdown 代码块）：
{"ratings": [{"idx": 0, "stem_ok": true, "solution_ok": true, "practiceable": true, "difficulty": 3, "difficulty_reason": "常规题型两步变形", "reason": "题干完整"}]}

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
    if args.model not in ALLOWED_MODELS:
        raise SystemExit(f"只允许用 {ALLOWED_MODELS}（决策人限定）")
    print(f"待判定 {len(todo)} 批（每批 {args.batch} 题）· 共 {len(questions)} 题")

    lock = threading.Lock()

    def do_batch(pair):
        base_idx, batch = pair
        # ⚠️ 上游偶发 502（实测：并发 16 时约 10/70 批）——**这里退避重试 3 次**，
        # 否则那批题会静默变成"没判定"，得靠整体再跑一遍来补（本项目的已知坑形态）。
        last: BaseException | None = None
        for attempt in range(3):
            try:
                out = ask_model(base=args.base_url, key=key, model=args.model,
                                max_output_tokens=args.max_output_tokens,
                                input_text=build_prompt(batch), schema=SCHEMA)
                return base_idx, out
            except BaseException as exc:      # SystemExit / 网络 / 解析，一律重试
                last = exc
                if attempt < 2:
                    time.sleep(4 * (attempt + 1))
        raise last if last else RuntimeError("未知失败")

    with ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as pool:
        futures = {pool.submit(do_batch, p): p for p in todo}
        for fut in as_completed(futures):
            try:
                base_idx, out = fut.result()
            except (SystemExit, OSError) as exc:
                # OSError：网关中途重启/超时（URLError 是它的子类）——单批失败不拖垮整轮，--resume 会重来
                print(f"  ⚠️ 批次 {futures[fut][0]} 失败：{str(exc)[:90]}", flush=True)
                continue
            batch = futures[fut][1]
            with lock:
                ratings = list(out["parsed"].get("ratings") or [])
                bad = 0
                for r in ratings:
                    idx = r.get("idx")
                    if not isinstance(idx, int) or not 0 <= idx < len(batch):
                        bad += 1
                        continue   # idx 越界/缺失会把判定错写到邻批题上 —— 宁可丢，等续跑重判
                    row = {**r, "idx": base_idx + idx}
                    done[row["idx"]] = row
                    with open(partial, "a", encoding="utf-8") as fh:
                        fh.write(json.dumps(row, ensure_ascii=False) + "\n")
                note = ""
                if not ratings:
                    note = "（⚠️ 本批 0 条返回）"
                elif bad:
                    note = f"（⚠️ {bad} 条 idx 异常已丢）"
                print(f"  批次 {base_idx}：已判定 {len(done)}/{len(questions)}{note}", flush=True)

    ok = sum(1 for i in range(len(questions)) if (done.get(i) or {}).get("practiceable"))
    rated_diff = 0
    for i, q in enumerate(questions):
        r = done.get(i)
        q["practiceable"] = bool(r and r.get("practiceable"))
        q["practiceable_reason"] = (r or {}).get("reason")
        diff = (r or {}).get("difficulty")
        if isinstance(diff, int) and 1 <= diff <= 4:
            q["agent_difficulty"] = diff
            q["agent_difficulty_reason"] = (r or {}).get("difficulty_reason")
            rated_diff += 1
        if args.apply:
            q["verify"] = "agent_rated" if q["practiceable"] else "unverified"
    dest.write_text(json.dumps(bank, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"\n✅ 判定完成：可练 {ok}/{len(questions)}（{round(100 * ok / max(1, len(questions)))}%）→ {dest}")
    print(f"   难度（agent 定，ADR-018）：{rated_diff}/{len(questions)} 题拿到 1-4 的整数")
    if args.apply:
        print("   已写 verify=agent_rated（可练）/ unverified（不可练）—— 前者会进练习池")
    return 0


if __name__ == "__main__":
    sys.exit(main())
