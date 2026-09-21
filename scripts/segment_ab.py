"""scripts/segment_ab.py —— ② 切题段的 **A/B 实验台**（不是最终实现）。

为什么存在：切题这一步有两种做法，谁好不能靠嘴说。
  A 组 = 正则锚点（`scripts/segment_corpus.py`，已跑通：1334 题、缺号完全吻合、解答切出率 81%）
  B 组 = **模型做语义边界判断**（本脚本）：喂一段块序列，让它回答"哪几个块属于题干、哪几个属于解答"

分工原则（这条比实现本身重要）：
  · **模型只做它擅长的**：判断"这段是不是一道题、题干到哪结束、解答从哪开始"（语义）
  · **机械的东西仍由代码做**：块的拼接、页码/bbox 出处、题号唯一性、缺号核对（可验证、零成本）
  · 两边**吃同一份输入**（`segment_corpus` 的 `_iter_blocks` / `_block_text`）—— 否则对比不成立

记账纪律：本脚本**只允许调用 `--model` 指定的那一个模型**（决策人限定：只用 DeepSeek V4.1，
别的模型可能很贵）。调用量 = 块窗口数，脚本开头会把窗口数与预估 token 打出来。

用法：
    python3 scripts/segment_ab.py --book jmdw-gaoshu --pages 10-30 --model deepseek-v4.1-flash
    python3 scripts/segment_ab.py --book jmdw-gaoshu --pages 10-30 --dry-run   # 只看窗口与成本
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from scripts.segment_corpus import PROFILES, _block_text, _iter_blocks  # noqa: E402

__all__ = ["build_windows", "ask_model", "main"]

DEFAULT_BASE = "http://127.0.0.1:18766/go/v1"      # 本机 codex-proxy（OpenCode GO 的本地网关）
DEFAULT_MODEL = "deepseek-v4.1-flash"              # ⚠️ 决策人限定：只用这一个

#: 模型只回这几样：题的编号 + 哪些块是题干 + 哪些块是解答 + 置信度。
#: **不给它自由发挥的余地** —— strict schema，块号用整数数组，越界即判无效。
SCHEMA = {
    "type": "object",
    "properties": {
        "questions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "number": {"type": "integer", "description": "题号（【N】里的 N）"},
                    "stem_block_ids": {"type": "array", "items": {"type": "integer"}},
                    "solution_block_ids": {"type": "array", "items": {"type": "integer"}},
                    "confidence": {"type": "number", "description": "0-1，切分把握"},
                    "note": {"type": "string", "description": "拿不准的地方，一句话；没有就空字符串"},
                },
                "required": ["number", "stem_block_ids", "solution_block_ids", "confidence", "note"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["questions"],
    "additionalProperties": False,
}

PROMPT = """下面是一本扫描版数学书 OCR 之后的**内容块序列**（每行一块：编号 | 类型 | 文字）。
块按阅读顺序排列，`equation` 块是排版出来的公式（内容为 LaTeX 原文），`image` 块是插图。

请找出这段里所有**题目**，对每一题回答三个问题：
1. 题号是多少（形如【12】的 N；注意排版可能把题号并进上一段的末尾，甚至并进公式里）
2. 哪些块属于**题干**（从题号所在块开始，到"解/证/分析/解法一"之前为止）
3. 哪些块属于**解答**（从"解/证/分析/解法一"那块开始，到下一题题号之前为止）

规则：
- 只回答这段里**真实存在**的题目，不要补充、不要推测缺失的题号。
- 块编号必须来自上面给出的序列，不要发明编号。
- 题干和解答的块编号必须连续覆盖，不许重叠。
- 拿不准的（比如某题没有解答、或边界疑似跨页）把 confidence 调低并在 note 里写一句。

⚠️ **只输出 JSON**（下面这个形状，不要任何解释、不要 Markdown 代码块、不要写"第几题"这样的散文）：
{"questions": [{"number": 1, "stem_block_ids": [11], "solution_block_ids": [12, 13, 14],
                "confidence": 0.9, "note": ""}]}

块序列：
__BLOCKS__"""


def _linearize(corpus: Path, book: str, page_lo: int, page_hi: int) -> list[dict]:
    """把指定页范围内的块摊平成 [{gid, page, idx, type, text}]，gid 是全局连续编号。

    这是 A、B 两组**共用**的输入形态 —— 同一个 gid 在两边指向同一个块。
    """
    profile = PROFILES[book]
    src = Path(corpus) / profile["dir"] / "full.middle.json"
    doc = json.loads(src.read_text(encoding="utf-8"))
    out: list[dict] = []
    for page_idx, block_idx, block in _iter_blocks(doc):
        if not (page_lo <= page_idx <= page_hi):
            continue
        btype = block.get("type")
        text = _block_text(block) or (block.get("image_path") or "")
        if not text:
            continue
        out.append({"gid": len(out), "page": page_idx, "idx": block_idx,
                    "type": btype, "text": text.strip()})
    return out


def build_windows(blocks: list[dict], size: int) -> list[list[dict]]:
    """按块数切窗口（**仅用于粗略估量**；正式跑用 `build_anchor_windows`）。

    按块数硬切有个致命缺陷：**会把一道题劈成两半** —— 跨窗口的那道题必然切错，
    而错在第几个窗口完全取决于 `size`。所以正式跑必须用锚点对齐的窗口。
    """
    return [blocks[i:i + size] for i in range(0, len(blocks), size)]


def build_anchor_windows(blocks: list[dict], anchor, per_window: int) -> list[list[dict]]:
    """**以题号锚点切窗口**：每窗恰好覆盖 `per_window` 道题，窗口边界落在题号之前。

    这是 A/B 里唯一正确的分工方式：**窗口边界（机械）用正则，窗口内的语义边界（题干/解答
    分界）交给模型**。于是"跨窗口把题切两半"这一类错误从根上不存在 —— 它不是被模型修好的，
    而是被机械规则排除掉的。
    """
    starts = [i for i, b in enumerate(blocks) if anchor.search(b["text"])]
    if not starts:
        return build_windows(blocks, 200)
    windows: list[list[dict]] = []
    for k in range(0, len(starts), per_window):
        lo = starts[k]
        hi = starts[k + per_window] if k + per_window < len(starts) else len(blocks)
        windows.append(blocks[lo:hi])
    return windows


def _render(blocks: list[dict]) -> str:
    return "\n".join(f"{b['gid']} | {b['type']} | {b['text'][:400]}" for b in blocks)


def ask_model(*, base: str, key: str, model: str, blocks: list[dict] | None = None,
              max_output_tokens: int = 32_000, timeout: int = 300,
              input_text: str | None = None, schema: dict | None = None) -> dict:
    """一次结构化抽取（Responses API 原生 json_schema）。**只打这一个模型。**

    `input_text` / `schema` 两个可选参数是为 ④ 标注（`scripts/annotate_kp.py`）加的：
    它要的是另一套 prompt 与 schema，但**传输层、错误处理、JSON 容错**完全一样 —— 与其复制一遍，
    不如把这段唯一实现参数化（传输层的坑踩过一次就够了：网关不强制 schema + 提示词必须显式提 JSON）。
    """
    prompt = input_text if input_text is not None else PROMPT.replace("__BLOCKS__", _render(blocks or []))
    payload = {
        "model": model,
        # 用 replace 而不是 str.format：prompt 里有 JSON 示例花括号，format 会把它当占位符
        "input": prompt,
        # ⚠️ 别抠：实测这个模型**每道题要烧掉约 1000 个"看不见的思考 token"**
        # （文本输出只有 200 token 上下，usage 里却是 8000+）。上限给小了就是"什么都拿不到"，
        # 而且失败的样子是 `incomplete=None / error=None`（最难查的那一种）。
        "max_output_tokens": max_output_tokens,
        "text": {"format": {"type": "json_schema", "name": "segmentation",
                            "schema": schema or SCHEMA, "strict": True}},
    }
    req = urllib.request.Request(
        base.rstrip("/") + "/responses", method="POST",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        raise SystemExit(f"模型调用失败 HTTP {e.code}：{e.read()[:200].decode('utf-8', 'replace')}")
    text = d.get("output_text")
    if not text:
        for item in d.get("output", []):
            for c in item.get("content", []) or []:
                if c.get("type") in ("output_text", "text"):
                    text = (text or "") + c.get("text", "")
    if not text:
        raise SystemExit(f"模型没回文本（incomplete={d.get('incomplete_details')}，"
                         f"error={d.get('error')}）—— 多半是 max_output_tokens 太小")
    # 这个网关**不强制** schema（只是提示），所以模型仍可能包一层 ```json 围栏 —— 剥掉再解析。
    raw = text.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1] if "\n" in raw else raw
        raw = raw.rsplit("```", 1)[0]
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        # 解析失败时把原文**存下来**再抛错：否则下次只能看到一个 JSONDecodeError，
        # 连模型到底写了什么都不知道（本轮就是这么浪费了一次 6000 token 的调用）。
        bad = REPO / "data" / "candidates" / "ab_raw_last_failure.txt"
        bad.parent.mkdir(parents=True, exist_ok=True)
        bad.write_text(text, encoding="utf-8")
        raise SystemExit(f"模型输出不是 JSON（原文存到 {bad}，前 200 字：{text[:200]!r}）")
    return {"parsed": parsed, "usage": d.get("usage") or {}}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="② 切题 A/B：正则 vs 模型（实验台，不改库）")
    ap.add_argument("--book", default="jmdw-gaoshu")
    ap.add_argument("--corpus", default="~/Documents/数学数据集")
    ap.add_argument("--pages", default="10-30", help="页范围，如 10-30（闭区间，page_idx）")
    ap.add_argument("--q-per-window", type=int, default=10, help="每个窗口覆盖多少道题（按题号锚点对齐）")
    ap.add_argument("--max-output-tokens", type=int, default=32_000)
    ap.add_argument("--base-url", default=DEFAULT_BASE)
    ap.add_argument("--model", default=DEFAULT_MODEL, help="⚠️ 只允许用 deepseek-v4.1-flash")
    ap.add_argument("--key-env", default="OPENCODE_API_KEY")
    ap.add_argument("--dry-run", action="store_true", help="只算窗口数与预估成本，不调用")
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)

    lo, hi = (int(x) for x in args.pages.split("-"))
    corpus = Path(args.corpus).expanduser()
    blocks = _linearize(corpus, args.book, lo, hi)
    anchor = PROFILES[args.book]["anchor"]
    windows = build_anchor_windows(blocks, anchor, args.q_per_window)
    chars = sum(len(b["text"]) for b in blocks)
    print(f"范围 page_idx {lo}-{hi}：{len(blocks)} 个内容块 → {len(windows)} 个窗口"
          f"（每窗 {args.q_per_window} 题，**边界对齐到题号锚点**）")
    print(f"估算输入 ≈ {chars} 字符 ≈ {chars // 2} tokens；输出上限 {args.max_output_tokens}/窗"
          f"（实测约 1000 token/题）")
    if args.dry_run:
        print("--dry-run：不调用模型")
        return 0

    key = os.environ.get(args.key_env)
    if not key:
        raise SystemExit(f"环境变量 {args.key_env} 没设置（凭据不进仓库、不进会话）")
    if args.model != DEFAULT_MODEL:
        raise SystemExit(f"只允许用 {DEFAULT_MODEL}（决策人限定，别的模型可能很贵）")

    results, usage_total = [], {"input_tokens": 0, "output_tokens": 0}
    failures = []
    for i, win in enumerate(windows):
        try:
            out = ask_model(base=args.base_url, key=key, model=args.model, blocks=win,
                            max_output_tokens=args.max_output_tokens)
        except SystemExit as exc:            # 单窗失败不拖垮整轮（并记下来，不静默）
            failures.append((i + 1, str(exc)[:120]))
            print(f"  ⚠️ 窗口 {i + 1}/{len(windows)} 失败：{str(exc)[:90]}")
            continue
        for k in usage_total:
            usage_total[k] += int(out["usage"].get(k) or 0)
        results.extend(out["parsed"].get("questions", []))
        print(f"  窗口 {i + 1}/{len(windows)}：块 {win[0]['gid']}-{win[-1]['gid']} → "
              f"{len(out['parsed'].get('questions', []))} 题")

    by_gid = {b["gid"]: b for b in blocks}
    questions = []
    for q in results:
        stem = "".join(by_gid[g]["text"] for g in q["stem_block_ids"] if g in by_gid)
        sol = "".join(by_gid[g]["text"] for g in q["solution_block_ids"] if g in by_gid)
        pages = [by_gid[g]["page"] for g in q["stem_block_ids"] + q["solution_block_ids"] if g in by_gid]
        questions.append({
            "number": q["number"], "stem": stem, "solution": sol,
            "confidence": q["confidence"], "note": q["note"],
            "page_idx": min(pages) if pages else None,
            "verify": "unverified",
        })
    questions.sort(key=lambda q: q["number"])

    dest = Path(args.out) if args.out else REPO / "data" / "candidates" / f"{args.book}.B.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps({"model": args.model, "pages": [lo, hi], "usage": usage_total,
                                "questions": questions}, ensure_ascii=False, indent=1) + "\n",
                    encoding="utf-8")
    have = sum(1 for q in questions if q["solution"].strip())
    nums = sorted(q["number"] for q in questions)
    print(f"\nB 组（{args.model}）：{len(questions)} 题 → {dest}")
    print(f"  题号 {nums[0]}..{nums[-1]} · 不同号 {len(set(nums))} · "
          f"解答切出 {have}/{len(questions)}（{round(100 * have / max(1, len(questions)))}%）")
    print(f"  token 用量：{usage_total}")
    missing = [n for n in range(nums[0], nums[-1] + 1) if n not in set(nums)] if nums else []
    print(f"  区间内缺号：{missing}")
    if failures:
        print(f"  ⚠️ 失败窗口 {len(failures)} 个：{failures}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
