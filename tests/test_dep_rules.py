"""tests/test_dep_rules.py —— 依赖纪律的机械执行者（H6 / ARCHITECTURE §11.4.1）。

三项检查（与 §11.4.1 一一对应）：
  1. AST 扫描：每个 .py 的 import 必须符合 `contracts/dep_matrix.toml` 的允许矩阵；
     第三方案件（既非 stdlib 也非本仓库域）一律红——这是 H1「服务端零依赖」与
     H2「禁 YAML」的机械化执行点（sys.stdlib_module_names 判定，不靠人眼白名单）。
  2. 单点检查：`importlib` 只允许出现在矩阵声明的 dynamic_loader（core/registry.py）。
  3. 清单对齐：modules/ 与 generators/ 下每个目录必须有 manifest.json，且 name == 目录名。

跑法：python3.12 -m unittest tests.test_dep_rules -v   （或 python3.12 tests/test_dep_rules.py）
"""

from __future__ import annotations

import ast
import json
import sys
import tomllib
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DOMAINS = ("core", "modules", "generators", "bridge", "contracts")


def _load_matrix() -> dict:
    with open(REPO / "contracts" / "dep_matrix.toml", "rb") as f:
        return tomllib.load(f)


def _py_files() -> list[Path]:
    """扫描**运行时代码**：跳过 tests/（测试不是运行域，不受 6×6 矩阵约束）。

    为什么不扫 tests/：矩阵管的是"运行时谁能 import 谁"，而测试天生要 import 被测对象
    （例：生成器自测 import 自己的 generator）——那会被误判成 generators→generators 横向依赖。
    """
    out: list[Path] = []
    for d in DOMAINS:
        out += sorted(p for p in (REPO / d).rglob("*.py") if "tests" not in p.parts)
    return out


def _domain_of(path: Path) -> str | None:
    rel = path.relative_to(REPO)
    return rel.parts[0] if rel.parts[0] in DOMAINS else None


def _imports(path: Path) -> list[tuple[int, str, int]]:
    """返回 [(行号, 顶层模块名, level)]；level>0 表示相对导入。"""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    found: list[tuple[int, str, int]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                found.append((node.lineno, alias.name.split(".")[0], 0))
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                found.append((node.lineno, "." * node.level + (node.module or ""), node.level))
            elif node.module:
                found.append((node.lineno, node.module.split(".")[0], 0))
    return found


class TestDepRules(unittest.TestCase):
    def setUp(self) -> None:
        self.matrix = _load_matrix()
        self.allow = self.matrix["allow"]
        self.loader = self.matrix["exemptions"]["dynamic_loader"]

    def test_imports_follow_matrix(self) -> None:
        """① AST 扫描：域间 import 必须被矩阵允许；第三方一律红。"""
        stdlib = set(sys.stdlib_module_names)
        problems: list[str] = []
        for py in _py_files():
            src_domain = _domain_of(py)
            if src_domain is None:
                continue
            for lineno, mod, level in _imports(py):
                rel = py.relative_to(REPO)
                if level:                      # 相对导入：同域内部，允许
                    continue
                if mod in stdlib:              # 标准库：允许（H1 的正面）
                    continue
                if mod in DOMAINS:
                    if not self.allow.get(src_domain, {}).get(mod, False):
                        problems.append(f"{rel}:{lineno} 违规依赖 {src_domain} → {mod}（矩阵禁止）")
                    continue
                problems.append(f"{rel}:{lineno} 引入了非标准库模块 `{mod}`（H1/H2 禁止第三方依赖）")
        self.assertEqual(problems, [], "依赖矩阵违规：\n  " + "\n  ".join(problems))

    def test_importlib_single_point(self) -> None:
        """② 单点检查：importlib 只许出现在 registry（§11.4.1 的唯一豁免）。"""
        hits = [p.relative_to(REPO).as_posix() for p in _py_files() if "importlib" in p.read_text(encoding="utf-8")]
        self.assertLessEqual(
            set(hits), {self.loader},
            f"importlib 只允许出现在 {self.loader}，实际命中：{hits}",
        )

    def test_manifest_alignment(self) -> None:
        """③ 清单对齐：每个模块/生成器目录都有 manifest.json，且 name == 目录名。"""
        problems: list[str] = []
        for root in ("modules", "generators"):
            for d in sorted((REPO / root).iterdir()):
                if not d.is_dir() or d.name.startswith((".", "_")):
                    continue
                man = d / "manifest.json"
                if not man.exists():
                    problems.append(f"{root}/{d.name} 缺 manifest.json")
                    continue
                data = json.loads(man.read_text(encoding="utf-8"))
                if data.get("name") != d.name:
                    problems.append(f"{root}/{d.name}/manifest.json 的 name={data.get('name')!r} 与目录名不一致")
                for key in ("name", "phase", "enabled", "description"):
                    if key not in data:
                        problems.append(f"{root}/{d.name}/manifest.json 缺必填字段 {key}")
        self.assertEqual(problems, [], "清单对齐问题：\n  " + "\n  ".join(problems))


if __name__ == "__main__":
    unittest.main(verbosity=2)
