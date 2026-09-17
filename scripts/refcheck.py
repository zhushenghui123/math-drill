#!/usr/bin/env python3
"""scripts/refcheck.py —— 文档自洽护栏（规格：docs/ARCHITECTURE.md §14）。

三类检查（缺一即不算完成）：
  C1  树 ↔ 契约双向映射：docs 里引用的仓库内路径必须在 §11.9 真值树里；
      树里点名的文件必须在磁盘上真的存在。
  C2  同值多定义：单源清单里的 key 只允许出现在 §13.1 表 / §11.9 树注释 /
      config/*.toml 三处，且多处写值必须一致。
  C3  文档自陈数字：跨文件的同一批数字（清单条目数、上游 pin sha）必须一致。

用法：
  python3 scripts/refcheck.py             # 跑真实检查；有红 → 退出码 1
  python3 scripts/refcheck.py --selftest  # 三类负例自测（红才是通过）

为什么手写而不复用现成工具（BRIEF「不造轮子总则」⑤）：
  现成的 markdown 链接检查器（markdown-link-check / lychee）只校验 URL 可达性，
  无法表达本项目特有的「真值树 ↔ 契约」语义（例如 `config/server.toml` 必须出现在
  §11.9 树里），也无法做单源值一致性；而通用 SAST 又不认识本仓库的目录纪律。
  故此处自写，代价是约 250 行 stdlib 代码，换来的是这三类历史上真实发生过的回归
  （v2.6 两次、v2.7 两次、v2.8 两次、v2.9 一次）被机械拦住。
"""

from __future__ import annotations

import argparse
import re
import sys
import tempfile
from pathlib import Path

# ---------------------------------------------------------------- 规则常数

TOP_DOMAINS = (
    "core", "bridge", "modules", "generators", "contracts", "config",
    "web", "tests", "scripts", "deploy", "docs", "data", "references", "patches",
)
ROOT_FILES = ("README.md", "LICENSE", "ATTRIBUTION", "THIRD_PARTY_NOTICES.md", ".gitignore")

# C1 豁免：宿主态路径（本就不在仓库树里）
HOST_PATH_PREFIXES = (
    "/etc/math-drill", "/opt/math-drill", "/var/lib/math-drill",
    "/var/log/math-drill.log", "/var/backups/math-drill",
    "/root/obsidian-livesync", "/usr/bin/python3", "/tmp/",
)
# C1 豁免：历史留档里刻意保留的旧名
HISTORICAL_TOKENS = (
    "qa", "server/config.py", "web/pages", "core/server.py",
    "config/modules.yaml", "ARCHITECTURE-v2.md",
)
# C1 豁免：规划期路径（T0 迁移前的旧位置）
PLANNING_PREFIXES = ("linalg-drill/",)
# C1 豁免：fork 相对路径（BOUNDARY 逐文件描述的是**上游**布局，不是本仓库树）
FORK_RELATIVE_PREFIXES = ("js/", "css/")
FORK_RELATIVE_TOKENS = ("index.html",)
# C1 豁免：别的项目（whale-moe 参照）的文件名
OTHER_PROJECT_TOKENS = ("bridge/control_api.py",)
# C1 豁免：gitignore 的运行时目录（内容刻意不入仓，如 data/bundle-v1.json）
GITIGNORED_PREFIXES = ("data/", "references/")
# C1b 豁免：上游继承面文件（BOUNDARY §0 清单；T4/T5 落位，T0 时不存在是正常的）
PENDING_FORK_FILES = (
    "app.js", "engine.js", "game.js", "cards.js", "classroom.js", "tools.js",
    "llm.js", "sm2.js", "agent.js", "data-questions.js", "data-knowledge.js",
    "page.html",
)
# "像文件"的判定：扩展名白名单（避免把 v2.8 / T0.5 / bridge.api / core.exact 当文件）
FILE_EXT_RE = re.compile(
    r"^[A-Za-z0-9_][A-Za-z0-9_.-]*\.(py|md|json|toml|js|css|html|sh|service|block|timer|txt|sql|log)$"
)
# C1 豁免：本文档集自己的节标记等明显非路径的东西
IGNORED_TOKEN_PREFIXES = ("§", "#", "-", "http", "v2.", "v1.", "→")

# C1 豁免：这些小节整体属"演进留档"
HISTORICAL_SECTION_MARKERS = ("## 2.", "### 10.B", "## 9. 变更记录", "### 11.6")

# C2 单源清单（key 名 → 允许出现的文件）
SINGLE_SOURCE_KEYS = (
    "bind_host", "port", "data_dir", "cookie_name", "cookie_ttl_days",
    "api_per_minute", "setup_max_failures", "setup_window_seconds", "tau_days",
)
SINGLE_SOURCE_FILES = ("docs/ARCHITECTURE.md", "config/server.toml", "config/server.example.toml")
ASSIGN_RE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^#\n]+?)\s*$")

# C3
SHA40_RE = re.compile(r"\b[0-9a-f]{40}\b")
COUNT_RE = re.compile(r"(\d+)\s*阻塞\s*\+\s*\*{0,2}(\d+)\s*清单")


# ---------------------------------------------------------------- 通用工具

def _headings(text: str) -> list[tuple[int, str]]:
    out = []
    for i, line in enumerate(text.splitlines(), 1):
        if line.startswith("#"):
            out.append((i, line.strip()))
    return out


def _historical_lines(text: str) -> set[int]:
    """返回属于"演进留档"小节的 1-based 行号集合。"""
    marks = _headings(text)
    spans: list[tuple[int, int]] = []
    for idx, (ln, title) in enumerate(marks):
        if any(title.startswith(m) for m in HISTORICAL_SECTION_MARKERS):
            end = marks[idx + 1][0] - 1 if idx + 1 < len(marks) else len(text.splitlines())
            spans.append((ln, end))
    return {ln for a, b in spans for ln in range(a, b + 1)}


def _backticked(text: str) -> list[str]:
    return re.findall(r"`([^`\n]+)`", text)


def _norm_token(tok: str) -> str:
    t = tok.strip().strip("：:，,。；;)")
    t = t.lstrip("./")
    t = t.rstrip("/")
    return t


def _is_ignored(tok: str) -> bool:
    # 含空格 = 命令行 / 并列写法（例：`scripts/db_init.py --load-bundle x.json`、`core / modules / ...`）
    if any(ch.isspace() for ch in tok):
        return True
    if any(tok.startswith(p) for p in IGNORED_TOKEN_PREFIXES):
        return True
    # 含箭头 = 依赖方向的散文写法（例：`core → module`），不是路径
    if any(ch in tok for ch in "→←"):
        return True
    # 含占位符/通配符的写法不参与判定（例：modules/<name>/tests/、web/tests/**）
    if any(ch in tok for ch in "<>…*$"):
        return True
    if tok.startswith(HOST_PATH_PREFIXES) or tok.startswith(PLANNING_PREFIXES):
        return True
    if tok.startswith(GITIGNORED_PREFIXES):
        return True
    if tok in OTHER_PROJECT_TOKENS:
        return True
    if tok.startswith(FORK_RELATIVE_PREFIXES) or tok in FORK_RELATIVE_TOKENS:
        return True
    if tok in HISTORICAL_TOKENS:
        return True
    # 仓库内路径形态：根文件，或以"顶层域 + /"开头，或恰好等于某个顶层域
    is_repo_path = (
        tok in ROOT_FILES
        or any(tok == d or tok.startswith(d + "/") for d in TOP_DOMAINS)
    )
    if not is_repo_path:
        return True   # 不是仓库内路径形态
    return False


def _tree_entries(docs: Path) -> tuple[set[str], set[str]]:
    """从 ARCHITECTURE.md §11.9 的树代码块抽取条目。

    返回 (全部条目名集合, 像文件名的条目集合)。
    """
    arch = (docs / "ARCHITECTURE.md").read_text(encoding="utf-8")
    lines = arch.splitlines()
    start = None
    for i, ln in enumerate(lines):
        if ln.startswith("### 11.9"):
            start = i
            break
    if start is None:
        return set(), set()
    block, fence = [], False
    for ln in lines[start:]:
        if ln.strip().startswith("```"):
            if fence:
                break
            fence = True
            continue
        if fence:
            block.append(ln)
    names: set[str] = set()
    for ln in block:
        body = re.sub(r"^[│├└─\s]+", "", ln).strip()
        if not body:
            continue
        path_part, _, comment = body.partition("#")
        for tok in re.split(r"[/\s]+", path_part):
            tok = tok.strip()
            if not tok or tok in {"..."}:
                continue
            names.add(tok)
        # 注释里点名的文件名（例：`deploy/  # math-drill.service / caddy.block / backup.timer`）
        for tok in re.findall(r"[A-Za-z0-9_][A-Za-z0-9_.-]*\.[A-Za-z0-9]+", comment):
            names.add(tok.split("/")[-1])
            names.add(tok.split("/")[-1].rsplit(".", 1)[0])
        # 注释里的大写文件名（`docs/  # ARCHITECTURE / JUDGE_CONTRACT / ...`）
        for tok in re.findall(r"\b[A-Z][A-Z0-9_]{2,}\b", comment):
            names.add(tok)
    files = {n for n in names if FILE_EXT_RE.match(n)}
    return names, files


# ---------------------------------------------------------------- C1

def check_c1(repo: Path, docs: Path) -> list[str]:
    problems: list[str] = []
    tree_names, tree_files = _tree_entries(docs)

    for md in sorted(docs.glob("*.md")):
        text = md.read_text(encoding="utf-8")
        skip = _historical_lines(text)
        for lineno, line in enumerate(text.splitlines(), 1):
            if lineno in skip:
                continue
            for tok in _backticked(line):
                if tok.startswith("/"):      # URL 路径（/api/*、/setup、/tests/run-all.js）
                    continue
                t = _norm_token(tok)
                if _is_ignored(t):
                    continue
                base = t.split("/")[-1]
                stem = base.rsplit(".", 1)[0] if "." in base else base
                if t in tree_names or base in tree_names or stem in tree_names:
                    continue
                problems.append(
                    f"C1 {md.name}:{lineno} 引用了树里没有的路径 `{t}`（§11.9 无此条目）"
                )

    # 反向：树里点名的文件必须在磁盘上存在
    on_disk = {p.name for p in repo.rglob("*") if p.is_file() and ".git" not in p.parts}
    for f in sorted(tree_files):
        if f in PENDING_FORK_FILES:
            continue
        if f not in on_disk:
            problems.append(f"C1 树里点名了 `{f}`，但磁盘上没有这个文件")
    return problems


# ---------------------------------------------------------------- C2

def check_c2(repo: Path, docs: Path) -> list[str]:
    problems: list[str] = []
    arch = docs / "ARCHITECTURE.md"
    arch_text = arch.read_text(encoding="utf-8")
    arch_lines = arch_text.splitlines()

    # §13.1 的允许区间
    lo = hi = None
    for i, ln in enumerate(arch_lines, 1):
        if ln.startswith("### 13.1"):
            lo = i
        elif lo and ln.startswith("### 13.2"):
            hi = i
            break
    if hi is None:
        hi = len(arch_lines)
    allowed_spans = {"docs/ARCHITECTURE.md": (lo or 0, hi)}

    seen: dict[str, list[tuple[str, int, str]]] = {}
    for key in SINGLE_SOURCE_KEYS:
        seen[key] = []

    targets = [(arch, "docs/ARCHITECTURE.md")]
    for extra in ("config/server.toml", "config/server.example.toml"):
        p = repo / extra
        if p.exists():
            targets.append((p, extra))
    for md in sorted(docs.glob("*.md")):
        if md != arch:
            targets.append((md, f"docs/{md.name}"))

    for path, label in targets:
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            m = ASSIGN_RE.match(line)
            if not m or m.group(1) not in SINGLE_SOURCE_KEYS:
                continue
            key, value = m.group(1), m.group(2).strip().strip('"')
            seen[key].append((label, lineno, value))
            if label not in SINGLE_SOURCE_FILES:
                problems.append(
                    f"C2 {label}:{lineno} 出现了单源值 `{key} = {value}`（域外：只许 §13.1 表 / 树注释 / config/*.toml）"
                )
            elif label in allowed_spans:
                a, b = allowed_spans[label]
                if not (a <= lineno <= b):
                    problems.append(
                        f"C2 {label}:{lineno} 的 `{key}` 出在 §13.1 区间之外（{a}-{b}）"
                    )
        # 域外的 key 名出现（不构成赋值）不判红——注释与说明是允许的

    for key, hits in seen.items():
        values = {v for _, _, v in hits}
        if len(values) > 1:
            where = "；".join(f"{l}:{n}={v}" for l, n, v in hits)
            problems.append(f"C2 单源值 `{key}` 出现多个不同取值：{where}")
    return problems


# ---------------------------------------------------------------- C3

def check_c3(repo: Path, docs: Path, fork_hint: Path | None = None) -> list[str]:
    problems: list[str] = []
    arch = (docs / "ARCHITECTURE.md").read_text(encoding="utf-8")
    dec = (docs / "DECISIONS.md").read_text(encoding="utf-8")
    attr = (repo / "ATTRIBUTION").read_text(encoding="utf-8") if (repo / "ATTRIBUTION").exists() else ""

    # (1) pin sha 跨文件一致
    shas = {s for s in SHA40_RE.findall(arch) + SHA40_RE.findall(attr)}
    if len(shas) > 1:
        problems.append(f"C3 上游 pin sha 出现多个取值：{sorted(shas)}")
    if not shas:
        problems.append("C3 未在 ARCHITECTURE / ATTRIBUTION 找到 40 位 pin sha")
    if fork_hint and fork_hint.exists() and shas:
        try:
            import subprocess
            head = subprocess.run(
                ["git", "-C", str(fork_hint), "rev-parse", "HEAD"],
                capture_output=True, text=True, check=True,
            ).stdout.strip()
            if head not in shas:
                problems.append(f"C3 实测 fork HEAD={head} 与文档声明的 pin 不一致：{sorted(shas)}")
        except Exception as exc:  # pragma: no cover
            problems.append(f"C3 无法读取 fork HEAD：{exc}")

    # (2) 变更记录行 vs ADR 小节标题里声明的数目
    declared_in_changelog = {}
    for m in re.finditer(r"\*\*v(\d+\.\d+)\*\*[^|]*?\|\s*([^|]*?)（(\d+)\s*阻塞\s*\+\s*\*{0,2}(\d+)\s*清单", arch):
        declared_in_changelog[m.group(1)] = (int(m.group(3)), int(m.group(4)))
    declared_in_adr = {}
    for m in re.finditer(r"ADR-012 · v(\d+\.\d+) 追加[^（]*（[^（]*?(\d+)\s*阻塞\s*\+\s*(\d+)\s*清单", dec):
        declared_in_adr[m.group(1)] = (int(m.group(2)), int(m.group(3)))
    for ver, cl in declared_in_changelog.items():
        if ver in declared_in_adr and declared_in_adr[ver] != cl:
            problems.append(
                f"C3 v{ver} 的数目对不上：变更记录写 {cl[0]}+{cl[1]}，ADR 写 {declared_in_adr[ver][0]}+{declared_in_adr[ver][1]}"
            )
    return problems


# ---------------------------------------------------------------- 自测

TINY_TREE = """# ARCHITECTURE

### 11.9 v2.5 真值树

```text
demo/
├── core/
│   ├── judge.py                   # 判定器
│   └── store.py                   # 存储
├── config/
│   └── server.toml                # 单源
└── README.md
```

### 13.1 常量与凭据的分家

```toml
[server]
bind_host = "127.0.0.1"
port = 8081
data_dir = "/var/lib/x"
```

### 13.2 静态根
"""


def _fixture(tmp: Path, *, docs_extra: str = "", tree: str = TINY_TREE,
             server_toml: str = "", attr_sha: str = "a" * 40) -> Path:
    repo = tmp / "repo"
    docs = repo / "docs"
    docs.mkdir(parents=True)
    (docs / "ARCHITECTURE.md").write_text(tree, encoding="utf-8")
    (docs / "DECISIONS.md").write_text("# DECISIONS\n", encoding="utf-8")
    (docs / "OTHER.md").write_text(docs_extra, encoding="utf-8")
    (repo / "ATTRIBUTION").write_text(f"{attr_sha}\n", encoding="utf-8")
    for rel in ("core/judge.py", "core/store.py", "config/server.toml", "README.md"):
        p = repo / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(server_toml if rel.endswith("server.toml") else "# stub\n", encoding="utf-8")
    return repo


def selftest() -> int:
    failures = []
    with tempfile.TemporaryDirectory() as td:
        # fixture A：引用了树里没有的路径 → C1 必须红
        repo = _fixture(Path(td), docs_extra="见 `core/ghost.py` 与 `config/missing.toml`。\n")
        c1 = check_c1(repo, repo / "docs")
        print(f"[selftest A] C1 命中 {len(c1)} 条（期望 >0）")
        if not c1:
            failures.append("A：引用不存在的路径却没报红")
    with tempfile.TemporaryDirectory() as td:
        # fixture B：同一单源值写两处且不一致 → C2 必须红
        bad = TINY_TREE.replace('port = 8081', 'port = 9999')
        repo = _fixture(Path(td), tree=bad,
                        server_toml='[server]\nport = 8081\n')
        c2 = check_c2(repo, repo / "docs")
        print(f"[selftest B] C2 命中 {len(c2)} 条（期望 >0）")
        if not c2:
            failures.append("B：单源值两处不一致却没报红")
    with tempfile.TemporaryDirectory() as td:
        # fixture C：pin sha 两处不一致 → C3 必须红
        repo = _fixture(Path(td), attr_sha="b" * 40)
        (repo / "docs" / "ARCHITECTURE.md").write_text(
            TINY_TREE + f"\n上游 pin `{'c' * 40}`\n", encoding="utf-8")
        c3 = check_c3(repo, repo / "docs")
        print(f"[selftest C] C3 命中 {len(c3)} 条（期望 >0）")
        if not c3:
            failures.append("C：pin sha 跨文件不一致却没报红")

    if failures:
        print("\n❌ 自测失败（checker 不能红比没有更糟）：")
        for f in failures:
            print("   -", f)
        return 1
    print("\n✅ 自测通过：三类负例都能被逮住（A→C1、B→C2、C→C3）")
    return 0


# ---------------------------------------------------------------- 主流程

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="文档自洽护栏（ARCHITECTURE §14）")
    ap.add_argument("--selftest", action="store_true", help="跑三类负例自测")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()

    repo = Path(__file__).resolve().parent.parent
    docs = repo / "docs"
    fork = Path("/home/myuser/workspaces/DeepSeek/math-practice-survey/clones/kaoyan-math-tutor")

    problems = check_c1(repo, docs) + check_c2(repo, docs) + check_c3(repo, docs, fork)
    if problems:
        print(f"❌ refcheck 发现 {len(problems)} 个问题：")
        for p in problems:
            print("  -", p)
        return 1
    print("✅ refcheck 全绿：C1 树↔契约 · C2 单源值 · C3 自陈数字")
    return 0


if __name__ == "__main__":
    sys.exit(main())
