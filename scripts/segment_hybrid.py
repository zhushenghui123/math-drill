"""scripts/segment_hybrid.py —— ② 切题段的**生产实现**：机械锚点 + 模型语义 + 机械校验。

契约：`contracts/corpus_segment.md`（产物字段 + 旁表 DDL 骨架）。
与 `scripts/segment_corpus.py`（A 组基线，纯正则）**并存** —— A/B 的可复现性不能因为升级而丢掉；
本文件是 B 组思路的生产化：**窗口边界用锚点（机械）、题干/解答边界用模型（语义）、产物用规则自检（机械）**。

三层各自的职责（改代码前先读，别把职责混起来）：
  ① **机械锚点**：形态容错重扫（`【N】` / `【N:M】` / `\textbf {[ N N N ]}`）+ **位置对账**（夹在 N−1/N+1 之间）
     + 窗口边界 + 页码/bbox/块号出处。**不做语义判断**。
  ② **模型语义**：只回答"哪几块是题干、哪几块是解答"（+ confidence/note）。**不碰题号**。
  ③ **机械校验**：覆盖对账（每个块要么归属某个题、要么落进**机械白名单**的非题目区）、
     解答里不得出现锚点、块号必须来自输入且连续不重叠。**模型的自报一律不信**。

⚠️ 自动修回的适用范围（契约 §4）：`corrupted` 的位置对账**只对"全局连号"成立**
   （吉米多维奇高数 `【N】` 1–1341 ✓）。别的书一律走人工 → `needs_human` 队列。

用法：
    python3 scripts/segment_hybrid.py --book jmdw-gaoshu --pages 10-47 --dry-run   # 只算窗口与成本
    python3 scripts/segment_hybrid.py --book jmdw-gaoshu --pages 10-47             # 真跑（调模型）
    python3 scripts/segment_hybrid.py --book jmdw-gaoshu --no-model                # 只做机械层与校验
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from scripts.segment_ab import DEFAULT_BASE, DEFAULT_MODEL, ask_model  # noqa: E402
from scripts.segment_corpus import PROFILES, _block_text, _iter_blocks  # noqa: E402

__all__ = ["SCHEMA_VERSION", "WHITELIST_VERSION", "loose_anchors", "main"]

SCHEMA_VERSION = 1

#: 覆盖对账用的白名单**规则版本** —— 它必须进产物（复核点名：违规计数型指标要配覆盖率读数同报，
#: 改了规则就要换版本号，否则两次跑的"未归属块数"不可比）。
WHITELIST_VERSION = "wl-2026-09-21-a"

#: 非题目区白名单：**只看块类型与正则，绝不信模型自报**（契约 §3-3）。
#: ⚠️ `index` 必须在内（目录页，实测 4 块）；`table`/`chart` **不在内**（实测它们跟着所属题目走）。
NON_QUESTION_TYPES = {"header", "footer", "page_number", "doc_title", "page_footnote", "index"}

#: 「§ N. <标题>」起头的知识点正文段（复核给出、我复跑 4/4）
SECTION_BODY = re.compile(r"^\s*§\s*\d+\s*\.")

#: 题型标题行：`paragraph_title` 且不以 `N.` / `(N)` 开头（如「基本题型」「有理函数的积分」）
TOPIC_TITLE_TAIL = re.compile(r"^\s*[(（]?\d")

#: 形态容错重扫的三类形态（顺序敏感：先试最严的，避免把 `\textbf {[ 5 5 0 ]}` 误读）
_OCR_ANCHOR = re.compile(r"【\s*(\d{1,4})\s*】")
_COLON_ANCHOR = re.compile(r"【\s*(\d{1,4})\s*[:：]\s*(\d{1,3})\s*】")      # 【1:26】→ 1126
_BRACKET_ANCHOR = re.compile(r"[\[［]\s*((?:\d\s*){2,4})[\]］]")             # [ 5 5 0 ] → 550


def anchor_spans(text: str) -> list[tuple[int, int, int, str, str]]:
    """形态容错重扫：`[(start, end, 题号, 原始串, 来源)]`，来源 ∈ {ocr, corrupted}。

    这是本文件里**唯一**允许读题号的地方。混淆点：`\\textbf {[ 5 5 0 ]}` 与 `【1:26】`
    都不是 `【N】`，但它们**在位**（夹在 N−1/N+1 之间），所以是 `corrupted` 而非 `inferred`。
    """
    out: list[tuple[int, int, int, str, str]] = []
    for m in _COLON_ANCHOR.finditer(text):
        out.append((m.start(), m.end(), int(m.group(1) + m.group(2)), m.group(0), "corrupted"))
    for m in _BRACKET_ANCHOR.finditer(text):
        digits = re.sub(r"\s+", "", m.group(1))
        out.append((m.start(), m.end(), int(digits), m.group(0), "corrupted"))
    for m in _OCR_ANCHOR.finditer(text):
        if _COLON_ANCHOR.search(m.group(0)):
            continue
        out.append((m.start(), m.end(), int(m.group(1)), m.group(0), "ocr"))
    # 同一位置可能被多种形态命中：按 (位置, 题号, 原始串) 去重后按出现顺序排
    seen, uniq = set(), []
    for item in out:
        key = (item[0], item[2], item[3])
        if key in seen:
            continue
        seen.add(key)
        uniq.append(item)
    return sorted(uniq, key=lambda t: t[0])


def loose_anchors(text: str) -> list[tuple[int, str, str]]:
    """`anchor_spans` 的瘦身版：`[(题号, 原始串, 来源)]`。"""
    return [(n, raw, kind) for _, _, n, raw, kind in anchor_spans(text)]


def split_multi_anchor(block: dict) -> list[dict]:
    """**块内含 ≥2 个题号 ⇒ 按锚点位置预切分**（机械层职责，不是模型的事）。

    实测坑：`gid 329` 一个块里同时有 `故应填2.【43】…【44】…` —— 不切的话，
    上一题的解答区间会变空、两题共享同一块，覆盖对账立刻报"重叠"（我第一版就报了）。
    宁可让这道题**没有解答**、也不要让两题共享一块 —— 前者可观测，后者会静默污染。
    """
    spans = anchor_spans(block["text"])
    if len(spans) <= 1:
        return [block]
    pieces, out = [], []
    for k, (start, _, _, _, _) in enumerate(spans):
        nxt = spans[k + 1][0] if k + 1 < len(spans) else len(block["text"])
        pieces.append((start, nxt))
    # `split_of` 用原始块坐标（`p<页>b<块>`）而不是 gid —— 切分发生在编号之前，此刻还没有 gid
    origin = f"p{block['page']}b{block['idx']}"
    if spans[0][0] > 0:                      # 锚点之前的尾巴仍属上一题的解答
        out.append({**block, "text": block["text"][:spans[0][0]], "split_of": origin})
    for (s, e) in pieces:
        out.append({**block, "text": block["text"][s:e], "split_of": origin})
    return [p for p in out if p["text"].strip()]


def load_blocks(corpus: Path, book: str, lo: int, hi: int) -> tuple[list[dict], Path]:
    """把页范围内的块摊平成全局连续编号的列表（A/B 两组共用同一种输入形态）。"""
    profile = PROFILES[book]
    src = Path(corpus) / profile["dir"] / "full.middle.json"
    doc = json.loads(src.read_text(encoding="utf-8"))
    raw_blocks: list[dict] = []
    for page_idx, block_idx, block in _iter_blocks(doc):
        if not (lo <= page_idx <= hi):
            continue
        raw_blocks.append({
            "page": page_idx,
            "idx": block_idx,
            "type": block.get("type"),
            "text": (_block_text(block) or block.get("image_path") or "").strip(),
            "bbox": block.get("bbox"),
        })
    # 块内多锚点先切分，再统一编号（编号必须与产物里的块号一致 ⇒ 只在这里编一次）
    blocks: list[dict] = []
    for b in raw_blocks:
        for piece in split_multi_anchor(b):
            blocks.append({"gid": len(blocks), **piece})
    return blocks, src


def anchor_windows(blocks: list[dict], per_window: int) -> list[list[dict]]:
    """窗口边界对齐到"带锚点的块" —— 保证一道题不被窗口劈开（机械职责）。"""
    starts = [i for i, b in enumerate(blocks) if loose_anchors(b["text"])]
    if not starts:
        return [blocks]
    out = []
    for k in range(0, len(starts), per_window):
        lo = starts[k]
        hi = starts[k + per_window] if k + per_window < len(starts) else len(blocks)
        out.append(blocks[lo:hi])
    return out


def reconcile(anchors: list[dict]) -> list[dict]:
    """**位置对账**：`corrupted` 位不靠"自己解析出的数"定题号，而靠**邻号间隙**反推。

    为什么不能信自己解析出来的数（实测教训）：`【1:26】` 按"冒号拼接"得 **126**，
    而它的真身是 **1126**（夹在【1125】与【1127】之间）。两者差一位数字，
    只有位置能判 —— 所以规则是：

      · 取它前面最近的锚点值 A、后面最近的锚点值 B；
      · `B − A == 2` ⇒ **V = A + 1**（唯一自洽解），来源记为 `reconciled`，原始串进 `evidence.raw`；
      · 否则 `unreconciled` ⇒ 交人工（宁可交给人，也不猜——"扫不到≠不存在"那三次教训换来的）。

    ⚠️ 该规则**只对"全局连号"成立**（契约 §4）：吉米多维奇高数 `【N】` 1–1341 ✓；
    别的书（`【N.M】` 逐章重算 / `习题 N + (N)` 章内连号）一律 `needs_human`。
    """
    anchors = sorted(anchors, key=lambda a: a["gid"])
    for i, a in enumerate(anchors):
        a["status"] = "ok" if a["source"] == "ocr" else "unreconciled"
        a.setdefault("parsed_value", a["number"])
        if a["source"] != "corrupted":
            continue
        prev = next((anchors[j] for j in range(i - 1, -1, -1)), None)
        nxt = next((anchors[j] for j in range(i + 1, len(anchors))), None)
        if prev and nxt and nxt["number"] - prev["number"] == 2:
            a["number"] = prev["number"] + 1
            a["status"] = "reconciled"
            a["neighbors"] = [prev["gid"], nxt["gid"]]
            a["neighbor_values"] = [prev["number"], nxt["number"]]
    return anchors


def coverage(blocks: list[dict], questions: list[dict]) -> dict:
    """覆盖对账：**每个内容块必须恰好归属一个题，或落进机械白名单的非题目区**。

    返回 `{unassigned: [...], non_question: n, assigned: n, overlaps: [...]}`。
    ⚠️ 顺序要求：本函数只看块类型与正则 —— 模型给的一切（`questions[]` 的块号）都要先过合法性校验。
    """
    assign: dict[int, str] = {}
    overlaps = []
    for q in questions:
        for gid in q["_stem_gids"] + q["_solution_gids"]:
            if gid in assign:
                overlaps.append({"gid": gid, "between": [assign[gid], q["qid"]]})
                continue
            assign[gid] = q["qid"]

    in_section_body = False
    unassigned, non_question = [], 0
    for b in blocks:
        gid = b["gid"]
        if gid in assign:
            in_section_body = False        # 题开始 ⇒ 正文段结束
            continue
        text = b["text"]
        if b["type"] in NON_QUESTION_TYPES:
            non_question += 1
            continue
        if SECTION_BODY.match(text):
            in_section_body = True         # 「§ N.…」起头 ⇒ 进入知识点正文段
            non_question += 1
            continue
        if in_section_body:
            non_question += 1              # 正文段一直延续到下一个题或下一个标题
            continue
        if b["type"] == "paragraph_title" and not TOPIC_TITLE_TAIL.match(text):
            non_question += 1              # 题型标题行（「基本题型」「有理函数的积分」）
            continue
        if not text:
            non_question += 1
            continue
        unassigned.append({"gid": gid, "page": b["page"], "idx": b["idx"],
                           "type": b["type"], "head": text[:80]})
    return {"unassigned": unassigned, "non_question": non_question,
            "assigned": len(assign), "overlaps": overlaps}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="② 切题生产版：机械 + 模型 + 校验（契约 contracts/corpus_segment.md）")
    ap.add_argument("--book", default="jmdw-gaoshu")
    ap.add_argument("--corpus", default="~/Documents/数学数据集")
    ap.add_argument("--pages", default="10-47", help="第一章 = 10-47（第二章标题在 p48）")
    ap.add_argument("--q-per-window", type=int, default=10)
    ap.add_argument("--max-output-tokens", type=int, default=32_000)
    ap.add_argument("--base-url", default=DEFAULT_BASE)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--key-env", default="OPENCODE_API_KEY")
    ap.add_argument("--no-model", action="store_true", help="只跑机械层与校验（不调模型）")
    ap.add_argument("--resume", action="store_true",
                    help="从 .partial.jsonl 续跑（长任务必须能续：2 小时的跑不能因为一次网络抖动全丢）")
    ap.add_argument("--concurrency", type=int, default=1,
                    help="并发窗口数。窗口之间**完全独立**，而瓶颈是云端 API 的**延时**（不是算力）"
                         "⇒ 并发是最便宜的提速手段（实测约 40 秒/窗，12 并发 ≈ 7 分钟跑完 134 窗）")
    ap.add_argument("--dry-run", action="store_true", help="只算窗口数与成本")
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)

    lo, hi = (int(x) for x in args.pages.split("-"))
    blocks, src = load_blocks(Path(args.corpus).expanduser(), args.book, lo, hi)
    anchors = reconcile([
        {"gid": b["gid"], "page": b["page"], "idx": b["idx"], "number": n,
         "raw": raw, "source": kind}
        for b in blocks for (n, raw, kind) in loose_anchors(b["text"])
    ])
    windows = anchor_windows(blocks, args.q_per_window)
    print(f"{args.book} page_idx {lo}-{hi}：{len(blocks)} 块 · {len(anchors)} 个锚点"
          f"（ocr {sum(1 for a in anchors if a['source'] == 'ocr')} / "
          f"corrupted {sum(1 for a in anchors if a['source'] == 'corrupted')}）· {len(windows)} 个窗口")
    for a in anchors:
        if a["source"] == "corrupted":
            print(f"  corrupted：题号 {a['number']} 原始串 {a['raw']!r} @ p{a['page']}b{a['idx']} → {a['status']}")
    if args.dry_run:
        chars = sum(len(b["text"]) for b in blocks)
        print(f"估算输入 ≈ {chars} 字符；输出上限 {args.max_output_tokens}/窗（实测约 1K token/题）")
        print("--dry-run：不调用模型")
        return 0

    by_gid = {b["gid"]: b for b in blocks}
    questions: list[dict] = []
    usage_total = {"input_tokens": 0, "output_tokens": 0}
    dest = Path(args.out) if args.out else REPO / "data" / "candidates" / f"{args.book}.hybrid.json"
    partial = dest.with_suffix(".partial.jsonl")
    done_numbers: set[int] = set()
    if args.resume and partial.exists():
        for line in partial.read_text(encoding="utf-8").splitlines():
            if line.strip():
                q = json.loads(line)
                questions.append(q)
                done_numbers.add(q["number"])
        print(f"  续跑：已从 {partial.name} 读回 {len(questions)} 题")
    if args.no_model:
        # 纯机械对照：题干 = 锚点块，解答 = 到下一个锚点前的所有块（就是 A 组的做法，用来对比校验器的读数）
        for i, a in enumerate(anchors):
            end = anchors[i + 1]["gid"] if i + 1 < len(anchors) else len(blocks)
            questions.append({"qid": f"imp.{args.book}.q{a['number']}", "number": a["number"],
                              "_stem_gids": [a["gid"]],
                              "_solution_gids": [g for g in range(a["gid"] + 1, end)],
                              "number_source": a["source"], "boundary_source": "mechanical"})
    else:
        key = os.environ.get(args.key_env)
        if not key:
            raise SystemExit(f"环境变量 {args.key_env} 没设置（凭据不进仓库、不进会话）")
        if args.model != DEFAULT_MODEL:
            raise SystemExit(f"只允许用 {DEFAULT_MODEL}（决策人限定，别的模型可能很贵）")
        # 并发：窗口之间完全独立，瓶颈是 API 延时 ⇒ 多窗口同时在飞是最便宜的提速。
        # ⚠️ 落盘要加锁（多个 worker 同时 append 会互相切断行）；print 也加锁，避免日志交错。
        write_lock = threading.Lock()

        def do_window(i: int, win: list[dict]) -> tuple[int, int, int]:
            out = ask_model(base=args.base_url, key=key, model=args.model, blocks=win,
                            max_output_tokens=args.max_output_tokens)
            made = 0
            for q in out["parsed"].get("questions", []):
                stem = [g for g in q["stem_block_ids"] if g in by_gid]
                sol = [g for g in q["solution_block_ids"] if g in by_gid]
                a = next((x for x in anchors if x["number"] == q["number"] and x["gid"] in stem), None)
                item = {
                    "qid": f"imp.{args.book}.q{q['number']}", "number": q["number"],
                    "_stem_gids": stem, "_solution_gids": sol,
                    "number_source": a["source"] if a else "inferred",
                    "number_evidence": ({"raw": a["raw"], "span": [a["page"], a["idx"]],
                                         "neighbors": a.get("neighbors")} if a else None),
                    "boundary_source": "model",
                    "confidence": q["confidence"], "note": q["note"],
                }
                with write_lock:
                    questions.append(item)
                    # 每窗落盘 ⇒ 崩了/断了也能续（长任务的第一条纪律）
                    with open(partial, "a", encoding="utf-8") as fh:
                        fh.write(json.dumps(item, ensure_ascii=False) + "\n")
                made += 1
            with write_lock:
                for k in usage_total:
                    usage_total[k] += int(out["usage"].get(k) or 0)
                print(f"  窗口 {i + 1}/{len(windows)}：块 {win[0]['gid']}-{win[-1]['gid']}"
                      f" → {made} 题（累计 {len(questions)}）", flush=True)
            return i, made, 1

        todo = []
        for i, win in enumerate(windows):
            nums = {n for b in win for (n, _, _) in loose_anchors(b["text"])}
            if args.resume and nums and nums <= done_numbers:
                print(f"  窗口 {i + 1}/{len(windows)}：已完成，跳过", flush=True)
                continue
            todo.append((i, win))
        ok = failed = 0
        with ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as pool:
            futures = {pool.submit(do_window, i, win): i for i, win in todo}
            for fut in as_completed(futures):
                try:
                    _, _, n = fut.result()
                    ok += n
                except SystemExit as exc:      # 单窗失败**不拖垮整轮**（记下来，不静默）
                    failed += 1
                    with write_lock:
                        print(f"  ⚠️ 窗口 {futures[fut] + 1} 失败：{str(exc)[:100]}", flush=True)
                except Exception as exc:       # 网络层异常同样不拖垮整轮
                    failed += 1
                    with write_lock:
                        print(f"  ⚠️ 窗口 {futures[fut] + 1} 异常：{type(exc).__name__}: {str(exc)[:90]}",
                              flush=True)
        print(f"  并发 {args.concurrency}：成功 {ok} 窗 · 失败 {failed} 窗", flush=True)

    questions.sort(key=lambda q: (q["number"], min(q["_stem_gids"] or [10 ** 9])))
    for q in questions:
        q["stem"] = "".join(by_gid[g]["text"] for g in q["_stem_gids"])
        q["solution"] = "".join(by_gid[g]["text"] for g in q["_solution_gids"])
        q["flags"] = []
        if not q["solution"].strip():
            q["flags"].append("no_solution")
        if any(loose_anchors(q["solution"])):
            q["flags"].append("anchor_in_solution")
        pages = [by_gid[g]["page"] for g in q["_stem_gids"] + q["_solution_gids"]]
        q["provenance"] = {"book": args.book, "page_idx": min(pages) if pages else None,
                           "blocks": sorted(q["_stem_gids"] + q["_solution_gids"]),
                           "source_file": str(src)}
        q["verify"] = "unverified"

    cov = coverage(blocks, questions)
    bad_ids = [g for q in questions for g in q["_stem_gids"] + q["_solution_gids"] if g not in by_gid]
    report = {
        "whitelist_version": WHITELIST_VERSION,
        "segment_schema": SCHEMA_VERSION,
        "unassigned_count": len(cov["unassigned"]),
        "unassigned_blocks": cov["unassigned"][:40],
        "non_question_blocks": cov["non_question"],
        "assigned_blocks": cov["assigned"],
        "overlaps": cov["overlaps"][:20],
        "bad_block_ids": bad_ids[:20],
        "anchor_in_solution": sum(1 for q in questions if "anchor_in_solution" in q["flags"]),
        "no_solution": sum(1 for q in questions if "no_solution" in q["flags"]),
        "number_source_counts": {s: sum(1 for q in questions if q["number_source"] == s)
                                 for s in ("ocr", "corrupted", "inferred")},
        "usage": usage_total,
    }
    bank = {"bank": args.book, "schema_version": SCHEMA_VERSION, "stage": "segment",
            "source": str(src), "page_range": [lo, hi],
            "questions": [{k: v for k, v in q.items() if not k.startswith("_")} for q in questions],
            "report": report}
    dest = Path(args.out) if args.out else REPO / "data" / "candidates" / f"{args.book}.hybrid.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(bank, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    print(f"\n=== 产物 {dest} ===")
    print(f"  题数 {len(questions)} · 覆盖对账：已归属 {cov['assigned']} 块 / 非题目区 {cov['non_question']} 块 / "
          f"**未归属 {len(cov['unassigned'])} 块**")
    print(f"  规则读数：解答含锚点 {report['anchor_in_solution']} · 无解答 {report['no_solution']} · "
          f"非法块号 {len(bad_ids)} · 重叠 {len(cov['overlaps'])}")
    print(f"  题号来源：{report['number_source_counts']}")
    print(f"  白名单版本 {WHITELIST_VERSION} · token {usage_total}")
    if cov["unassigned"]:
        print("  未归属样例：")
        for u in cov["unassigned"][:5]:
            print(f"    p{u['page']}b{u['idx']} [{u['type']}] {u['head']!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
