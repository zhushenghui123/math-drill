"""scripts/segment_corpus.py —— 数据管线 **② segment（题目切割）** 的机械段实现。

规格：`docs/DATA_PIPELINE.md` §1（六段流水线）、§2（验证分级：本脚本产出一律 `unverified`）、
§2.A（provenance：每题必须带 page/bbox，否则将来坏题只能删不能修）、§5（机械段工具面）。

**为什么读 `full.middle.json` 而不是 `full.md`**：markdown 里只有每 20 页一条
`<!-- p0001-0020 -->` 的批次注释，**没有页级标记**；而 provenance 要求的
`page` 与 `bbox` 只存在于 middle.json 的 `pages[].page_idx` 与 `blocks[].bbox`
（bbox 是 0-1 归一化坐标，page_idx 是 0-based 绝对页号）。

**它做什么**：把一本书的块流切成「题干 / 解答」两段，带上出处与可疑标记，吐一份**候选 JSON**。
**它不做什么**（别把这一步想大）：不做公式规范化（③）、不做知识点标注（④）、
不做答案验证（⑤）、不写库。候选 JSON 是给人过目与下一步消费的中间产物。

用法：
    python3 scripts/segment_corpus.py --book jmdw-gaoshu \
        --corpus ~/Documents/数学数据集 --out data/candidates/jmdw-gaoshu.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

__all__ = ["PROFILES", "segment_book", "main", "SCHEMA_VERSION"]

SCHEMA_VERSION = 1

#: 块类型里属于**排版噪声**的（页眉页脚页码），切题时丢掉但不丢证据（计数留着）
NOISE_TYPES = {"header", "footer", "page_number"}

#: 公式里的"多位数字被空格劈开"（MinerU 系统性产物：`\\binom{1 1 0 0}{2 0 0}`）。
#: ③ formula 段要修的正是它 —— 本脚本只**标记位置**，不改内容（切割与清洗分开，
#: 这样"切错"与"洗错"永远是两笔可分辨的账）。
DIGIT_SPLIT = re.compile(r"(?<=\d)\s+(?=\d)")

#: 一本书的切题档 —— 题号体系不同，档就不同（DATA_PIPELINE §3 实测三套体系）。
PROFILES: dict[str, dict] = {
    # 吉米多维奇 高数：`【N】` 全书全局连续 1-1341。已知 9 个缺号、2 处重复号（实测）。
    "jmdw-gaoshu": {
        "dir": "jmdw-gaoshu-吉米多维奇高等数学习题精选精解",
        "title": "吉米多维奇 高等数学习题精选精解（第2版）",
        # 题号锚点：**不限行首** —— 实测 6 个题号（34/36/295/398/906/1076）没独立成行，
        # 其中 906 还埋在 ` $$\\text{【906】}…$$ ` 里。只认行首会**静默丢这 6 题**。
        "anchor": re.compile(r"【(\d{1,4})】"),
        # 解答起头：这些书里 `解` 独立起段
        "solution_start": re.compile(r"^\s*解\s*[:：]?\s*"),
        "expect_max": 1341,          # 用于"切全了没有"的自检（已知缺号另列）
        "known_gaps": [49, 50, 208, 434, 550, 884, 907, 1126, 1197],
        "known_duplicates": [206, 1297],
    },
    # 吉米多维奇 概率：`【N.M】` = 题型号.题序，**每章每题型重新起算**（实测全书 606 次出现）。
    # ⇒ ① 单看数字一定撞车；② **邻号对账不成立**（"N−1/N+1"在不同章里不是同一个序列）。
    "jmdw-gailv": {
        "dir": "jmdw-gailv-吉米多维奇概率论与数理统计习题精选精解",
        "title": "吉米多维奇 概率论与数理统计习题精选精解",
        "anchor": re.compile(r"【(\d{1,3}\.\d{1,3})】"),
        "solution_start": re.compile(r"^\s*解\s*[:：]?\s*"),
        "number_kind": "chapter_scoped",   # 逐章重算 ⇒ 题号是**标签**不是序号；qid 用阅读序
        "expect_max": None,
        "known_gaps": [],
        "known_duplicates": [],
    },
    # 同济 / 浙大：`习题 N-M` 分节，节内题号 `N.` 是**标题行**（实测同济全解上 697 个行首编号、
    # 400 个行首「解」）。⇒ ① 锚点只从 `paragraph_title` 里取；② 节内重算 ⇒ 不做邻号对账。
    "tongji-quanjie-1": {
        "dir": "tongji-quanjie-1-同济高等数学习题全解指南上册",
        "title": "同济 高等数学习题全解指南 上册（第七版）",
        "anchor": re.compile(r"^\s*(\d{1,3})\.\s"),
        "require_section": re.compile(r"^\s*(?:总)?习题\s*\d"),
        "solution_start": re.compile(r"^\s*解\s*[:：]?\s*"),
        "number_kind": "chapter_scoped",
        "expect_max": None, "known_gaps": [], "known_duplicates": [],
    },
    "tongji-quanjie-2": {
        "dir": "tongji-quanjie-2-同济高等数学习题全解指南下册",
        "title": "同济 高等数学习题全解指南 下册（第七版）",
        "anchor": re.compile(r"^\s*(\d{1,3})\.\s"),
        "require_section": re.compile(r"^\s*(?:总)?习题\s*\d"),
        "solution_start": re.compile(r"^\s*解\s*[:：]?\s*"),
        "number_kind": "chapter_scoped",
        "expect_max": None, "known_gaps": [], "known_duplicates": [],
    },
    "zheda-quanjie": {
        "dir": "zheda-quanjie-浙大概率论与数理统计习题全解指南",
        "title": "浙大 概率论与数理统计 习题全解指南（第四版）",
        "anchor": re.compile(r"^\s*(\d{1,3})\.\s"),
        "require_section": re.compile(r"^\s*(?:总)?习题\s*\d"),
        "solution_start": re.compile(r"^\s*解\s*[:：]?\s*"),
        "number_kind": "chapter_scoped",
        "expect_max": None, "known_gaps": [], "known_duplicates": [],
    },
    # 教材三本：**例题（例N）**是"题目+解答同书"的部分 —— 决策人 2026-09-21 明确要求
    # "没有答案的、光有例题的也能跑"（ADR-020）。课后习题（习题 N-M）无答案，暂不取。
    "tongji-jiaocai-1": {
        "dir": "tongji-jiaocai-1-同济高等数学教材上册第七版",
        "title": "同济 高等数学 教材 上册（第七版）",
        # 教材里**两套编号并存**：正文例题 `例N`（无点）与课后习题 `N.`（可带 `*` 难度星）。
        # 实测模型抓到的主要是后者（`*10. 利用泰勒公式求下列极限:`）—— 决策人 2026-09-21 明确
        # "没有答案的、光有例题的也能跑"，所以两套都要认；否则它们全落 `inferred`（实测 667/677）。
        "anchor": re.compile(r"^\s*(?:例\s*)?\*?\s*(\d{1,3})[.\s]"),
        "solution_start": re.compile(r"^\s*解\s*[:：]?\s*"),
        "number_kind": "chapter_scoped",
        "expect_max": None, "known_gaps": [], "known_duplicates": [],
    },
    "tongji-jiaocai-2": {
        "dir": "tongji-jiaocai-2-同济高等数学教材下册第七版",
        "title": "同济 高等数学 教材 下册（第七版）",
        "anchor": re.compile(r"^\s*(?:例\s*)?\*?\s*(\d{1,3})[.\s]"),
        "solution_start": re.compile(r"^\s*解\s*[:：]?\s*"),
        "number_kind": "chapter_scoped",
        "expect_max": None, "known_gaps": [], "known_duplicates": [],
    },
    "zheda-jiaocai": {
        "dir": "zheda-jiaocai-浙大概率论与数理统计教材第四版",
        "title": "浙大 概率论与数理统计 教材（第四版）",
        "anchor": re.compile(r"^\s*(?:例\s*)?\*?\s*(\d{1,3})[.\s]"),
        "solution_start": re.compile(r"^\s*解\s*[:：]?\s*"),
        "number_kind": "chapter_scoped",
        "expect_max": None, "known_gaps": [], "known_duplicates": [],
    },
    # 吉米多维奇 线代（2026-09-23 新 OCR，决策人在学线代）：
    # 题号 `【N.M】` = 节.题序（实测第一批产物里是 `【4.10】``【4.12】` 这种），
    # 与 `jmdw-gailv` **同型** ⇒ 同样不做邻号对账（"N−1/N+1"跨节不是同一个序列）。
    "jmdw-xiandai": {
        "dir": "jmdw-xiandai-吉米多维奇线性代数习题精选精解",
        "title": "吉米多维奇 线性代数习题精选精解",
        "anchor": re.compile(r"【(\d{1,3}\.\d{1,3})】"),
        "solution_start": re.compile(r"^\s*解\s*[:：]?\s*"),
        "number_kind": "chapter_scoped",
        "expect_max": None,
        "known_gaps": [],
        "known_duplicates": [],
    },
}


def _block_text(block: dict) -> str:
    """把一个块的 content 摊平成字符串（content 可能是 str / list / 嵌套 dict）。

    `equation` 块的 content 就是 LaTeX 本体（它同时还有 `image_path` 指向公式截图 ——
    截图留着，将来 LaTeX 保真度抽检要用它做对照）。
    """
    c = block.get("content")

    def flat(x) -> str:
        if x is None:
            return ""
        if isinstance(x, str):
            return x
        if isinstance(x, list):
            return "".join(flat(i) for i in x)
        if isinstance(x, dict):
            return flat(x.get("content"))
        return ""

    return flat(c)


def _iter_blocks(doc: dict):
    """按 (page_idx, 块序号) 产出块 —— 这就是文档里的阅读序，不另做排序猜测。"""
    for page in doc.get("pages", []):
        for i, block in enumerate(page.get("blocks", [])):
            yield page["page_idx"], i, block


def _section_of(block: dict, state: dict) -> str:
    """维护"当前章节标题"栈：doc_title（章）/ paragraph_title（节、题型）。"""
    if block.get("type") == "doc_title":
        state["chapter"] = _block_text(block).strip()
    elif block.get("type") == "paragraph_title":
        title = _block_text(block).strip()
        # 形如「2. 函数的主要性质」的编号小标题属于正文，不进 provenance 路径；
        # 「求一元函数的定义域」这类才是题型标题。判据：不以数字编号开头。
        if title and not re.match(r"^\d+[.、]", title) and len(title) <= 30:
            state["topic"] = title
    return " / ".join(x for x in (state.get("chapter"), state.get("topic")) if x)


def _flags_of(stem: str, solution: str, *, anchored_mid: bool, has_image: bool) -> list[str]:
    flags: list[str] = []
    if DIGIT_SPLIT.search(stem) or DIGIT_SPLIT.search(solution):
        flags.append("digit_split")          # ③ 段要修的公式数字劈裂
    if not solution.strip():
        flags.append("no_solution")          # 只有题干没有解答（或解答没切到）
    if not stem.strip():
        flags.append("empty_stem")
    if anchored_mid:
        flags.append("anchor_mid_block")     # 题号不在块首（排版合并），切面要对齐
    if has_image:
        flags.append("has_image")
    return flags


def segment_book(corpus: Path, book: str, *, limit: int | None = None) -> dict:
    """把一本书切成候选题目列表（纯函数式：输入目录 + 书 id，输出 dict）。"""
    profile = PROFILES.get(book)
    if profile is None:
        raise SystemExit(f"没有 {book!r} 的切题档；现有：{sorted(PROFILES)}")

    src = Path(corpus) / profile["dir"] / "full.middle.json"
    if not src.is_file():
        raise SystemExit(f"找不到 {src}（--corpus 指向「数学数据集」根目录）")
    doc = json.loads(src.read_text(encoding="utf-8"))

    questions: list[dict] = []
    seen_numbers: dict[int, int] = {}
    state: dict = {}
    cur: dict | None = None
    noise = 0

    def flush() -> None:
        """收尾当前题（题与题之间没有分隔符，靠下一个锚点或流结束）。"""
        nonlocal cur
        if cur is None:
            return
        number = cur["number"]
        seen_numbers[number] = seen_numbers.get(number, 0) + 1
        dup = seen_numbers[number]
        qid = f"imp.{book}.q{number}" + (f"b{dup}" if dup > 1 else "")
        stem = "\n".join(cur["stem"]).strip()
        solution = "\n".join(cur["solution"]).strip()
        questions.append({
            "qid": qid,
            "number": number,
            "section": cur["section"],
            "stem": stem,
            "solution": solution,
            "provenance": {
                "book": book,
                "title": profile["title"],
                "page_idx": cur["page_idx"],          # 0-based 绝对页号（可回退到扫描页）
                "bbox": cur["bbox"],                  # 0-1 归一化，锚点所在块的位置
                "blocks": cur["blocks"],              # 参与本题的块序号（页内）
                "source_file": str(src.relative_to(Path(corpus))),
            },
            # DATA_PIPELINE §2：OCR 直出**一律 unverified**，只能进审校队列，不进练习池
            "verify": "unverified",
            "flags": _flags_of(stem, solution,
                               anchored_mid=cur["anchored_mid"],
                               has_image=cur["has_image"]),
        })
        cur = None

    for page_idx, block_idx, block in _iter_blocks(doc):
        btype = block.get("type")
        if btype in NOISE_TYPES:
            noise += 1
            continue
        text = _block_text(block)
        section = _section_of(block, state)
        if cur is not None:
            cur["section"] = cur["section"] or section
            cur["blocks"].append(block_idx)
            if btype == "image" or block.get("image_path"):
                cur["has_image"] = True

        # 题号锚点：**text 与 equation 都要扫** —— 有题号埋在公式里（实测 906）
        matches = list(profile["anchor"].finditer(text))
        if not matches:
            if cur is not None:
                # 题干 → 解答的切换点：`解` 独立起段（实测这些书统一如此）。
                # 漏了这一步的症状是"所有题都没解答"——本脚本第一次跑就踩了（1334/1334）。
                if cur["phase"] == "stem" and profile["solution_start"].match(text):
                    cur["phase"] = "solution"
                (cur["solution"] if cur["phase"] == "solution" else cur["stem"]).append(text)
            continue

        # 一个块里可能同时有"上一题的尾巴"和"新题的题号"：按锚点切开逐段归属
        for mi, m in enumerate(matches):
            start = m.start()
            end = matches[mi + 1].start() if mi + 1 < len(matches) else len(text)
            head = text[:start]
            body = text[start:end]
            if cur is not None and head.strip():
                (cur["solution"] if cur["phase"] == "solution" else cur["stem"]).append(head)
            flush()                      # 前一段收尾（可能为 None）
            if limit is not None and len(questions) >= limit:
                return _wrap(book, profile, doc, questions, seen_numbers, noise, src)
            cur = {
                "number": int(m.group(1)),
                "section": section,
                "stem": [body],
                "solution": [],
                "phase": "stem",
                "page_idx": page_idx,
                "bbox": block.get("bbox"),
                "blocks": [block_idx],
                "anchored_mid": start > 0,
                "has_image": bool(block.get("image_path")),
            }

    flush()
    return _wrap(book, profile, doc, questions, seen_numbers, noise, src)


def _wrap(book: str, profile: dict, doc: dict, questions: list[dict],
          seen_numbers: dict[int, int], noise: int, src: Path) -> dict:
    numbers = sorted(seen_numbers)
    missing = [n for n in range(1, (numbers[-1] if numbers else 0) + 1) if n not in seen_numbers]
    flags: dict[str, int] = {}
    for q in questions:
        for f in q["flags"]:
            flags[f] = flags.get(f, 0) + 1
    return {
        "bank": book,
        "schema_version": SCHEMA_VERSION,
        "stage": "segment",                      # 管线 ② 段产物（③④⑤ 都还没做）
        "source": str(src),
        "book_title": profile["title"],
        "page_count": len(doc.get("pages", [])),
        "counts": {
            "questions": len(questions),
            "distinct_numbers": len(seen_numbers),
            "missing_numbers": len(missing),
            "noise_blocks_skipped": noise,
            "flag_counts": flags,
        },
        "missing_numbers": missing,
        "duplicate_numbers": sorted(n for n, c in seen_numbers.items() if c > 1),
        "expected": {
            "max": profile.get("expect_max"),
            "known_gaps": profile.get("known_gaps", []),
            "known_duplicates": profile.get("known_duplicates", []),
        },
        "questions": questions,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="② segment：把 OCR 块流切成题目候选（不写库）")
    ap.add_argument("--book", default="jmdw-gaoshu")
    ap.add_argument("--corpus", default="~/Documents/数学数据集")
    ap.add_argument("--out", default=None, help="默认 data/candidates/<book>.json（data/ 不入仓）")
    ap.add_argument("--limit", type=int, default=None, help="只切前 N 题（调试用）")
    args = ap.parse_args(argv)

    corpus = Path(args.corpus).expanduser()
    out = Path(args.out) if args.out else REPO / "data" / "candidates" / f"{args.book}.json"
    bank = segment_book(corpus, args.book, limit=args.limit)

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(bank, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    c = bank["counts"]
    print(f"✅ {args.book}：切出 {c['questions']} 题 → {out}")
    print(f"   题号：{c['distinct_numbers']} 个不同号 · 缺号 {c['missing_numbers']} 处 · "
          f"重复号 {len(bank['duplicate_numbers'])} 处")
    print(f"   缺号明细：{bank['missing_numbers']}")
    print(f"   已知缺号（README 实测）：{bank['expected']['known_gaps']}")
    print(f"   标记：{c['flag_counts']}")
    print(f"   跳过排版噪声块：{c['noise_blocks_skipped']}（页眉/页脚/页码）")
    print("⚠️ 全部为 unverified（DATA_PIPELINE §2）：只进审校队列，**不进练习池**")
    return 0


if __name__ == "__main__":
    sys.exit(main())
