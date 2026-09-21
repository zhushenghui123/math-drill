"""scripts/db_init.py —— 建表 + `schema_version` + 灌库（T7 部署前置，BRIEF T6/T7）。

用法：
    python3 scripts/db_init.py --data-dir /var/lib/math-drill --load-bundle data/bundle-v1.json
    python3 scripts/db_init.py --load-kp-js web/js/data-knowledge.js     # 68 考点树 → kp 表
    python3 scripts/db_init.py --schema-only                             # 只建表

为什么建表在这里而不在模块里：铁律 3（持久层归 core）；`Store` 是唯一建表实现，
本脚本只是**调用方**（部署前置），不自己写 CREATE TABLE。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from core.store import Store  # noqa: E402


def default_data_dir(repo: Path) -> str:
    with open(repo / "config" / "server.toml", "rb") as f:
        return tomllib.load(f)["server"]["data_dir"]


NODE_RE = re.compile(
    r"\{\s*id:\s*'(\w+)',\s*title:\s*'([^']*)',\s*difficulty:\s*(\d+),\s*exam:\s*('all'|\[[^\]]*\])"
)
CHAPTER_RE = re.compile(r"name:\s*'([^']*)'")
#: ⚠️ 三个分类 id 必须与 `web/js/data-knowledge.js` **逐字一致**。原来这里写的是
#: `(calculus|linear|probability)` —— 但知识树里概率的 id 是 **`prob`**，于是第三类
#: 一个都匹配不上：`subject` 停在 `linear` 上，**概率的 34 个考点全被算进线性代数**
#: （2026-09-21 实测：kp 表只有 calculus 34 / linear 34，没有 prob）。
#: 改这里之前先看 `tests/test_kp_parse.py` —— 它按真实知识树文件断言三个分类的数量。
CATEGORY_RE = re.compile(r"id:\s*'(calculus|linear|prob)',\s*name:\s*'([^']*)'")


def parse_kp_js(path: Path) -> list[dict]:
    """从 fork 的 `web/js/data-knowledge.js` 抽出 68 考点树（BOUNDARY 裁定：可导出为 kp）。

    只抽 id/title/difficulty/exam + 所属分类与章名——正文（content/example）不入库。
    """
    text = path.read_text(encoding="utf-8")
    rows: list[dict] = []
    subject = ""
    chapter = ""
    # 按出现顺序扫描：分类 → 章名 → 节点
    tokens = []
    for m in CATEGORY_RE.finditer(text):
        tokens.append((m.start(), "category", m.group(1), m.group(2)))
    for m in CHAPTER_RE.finditer(text):
        tokens.append((m.start(), "chapter", "", m.group(1)))
    for m in NODE_RE.finditer(text):
        tokens.append((m.start(), "node", m.group(1), "", m.group(2), m.group(3), m.group(4)))
    tokens.sort(key=lambda t: t[0])
    for t in tokens:
        if t[1] == "category":
            subject = t[2]
        elif t[1] == "chapter":
            chapter = t[3]
        else:
            _, _, kid, _, title, difficulty, exam_raw = t
            if exam_raw == "'all'":
                exam = "all"
            else:
                exam = ",".join(re.findall(r"'([^']*)'", exam_raw))
            rows.append({"id": kid, "title": title, "chapter": chapter,
                         "subject": subject, "exam": exam, "related": None})
    # 去重（同一 id 只留第一条）
    seen, out = set(), []
    for r in rows:
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        out.append(r)
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="建表 + 灌库（部署前置）")
    ap.add_argument("--repo", default=str(REPO))
    ap.add_argument("--data-dir", default=None, help="默认取 config/server.toml 的 data_dir")
    ap.add_argument("--schema-only", action="store_true")
    ap.add_argument("--load-bundle", default=None)
    ap.add_argument("--load-kp-js", default=None)
    args = ap.parse_args(argv)

    repo = Path(args.repo)
    data_dir = args.data_dir or default_data_dir(repo)
    store = Store(data_dir)
    print(f"数据目录 {data_dir}（schema_version={store.schema_version}）")

    if args.load_kp_js:
        kp_path = Path(args.load_kp_js)
        rows = parse_kp_js(kp_path)
        n = store.load_kp(rows)
        print(f"✅ kp：从 {kp_path.name} 解析 {len(rows)} 个考点，入库 {n} 行")
        if len(rows) < 60:
            print(f"⚠️ 考点数偏少（{len(rows)}），确认知识树文件是否完整", file=sys.stderr)

    if args.load_bundle:
        bundle_path = Path(args.load_bundle)
        bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
        questions = bundle["questions"]
        n = store.load_questions(questions)
        print(f"✅ questions：从 {bundle_path.name} 灌入 {n} 题"
              f"（bundle_version={bundle.get('bundle_version')}）")

    if not args.schema_only:
        print(f"现状：questions={store.question_count()} 行，kp={store.kp_count()} 行，"
              f"attempts={len(store.list_attempts())} 行")
    store.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
