"""tests/test_judge.py —— 判定契约的验收测试（docs/JUDGE_CONTRACT.md §5）。

结构与契约一一对应：
  §5.1 回归集 10 例（5 控制 + 5 攻击，先红后绿）
  §5.2 类型边界攻击集 6 例
  §5.3 性质测试 3 条（各 300 例，随机但固定种子 → 可复现）

TDD 顺序（BRIEF T1）：本文件先写、先跑出红，再实现 core/judge.py 跑绿。
"""

from __future__ import annotations

import random
import re
import sys
import unittest
from fractions import Fraction
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from core.judge import JudgeError, judge, judge_by_qid, norm  # noqa: E402
from contracts.answer_types import AUTO_JUDGED, DEFERRED, AnswerType  # noqa: E402


# ---------------------------------------------------------------- §5.1

class TestRegression(unittest.TestCase):
    """§5.1：外部评审给的 10 例。5 控制必须判对，5 攻击必须不判成 true。"""

    CASES = [
        # (编号, 类别, 用户输入, 标准答案, 期望 true/false)
        (1, "控制", "1", "1", True),
        (2, "控制", "3/2", "1.5", True),
        (3, "控制", "-1/2", "-0.5", True),
        (4, "控制", r"\pi", "pi", True),
        (5, "控制", "0.5", "1/2", True),
        (6, "攻击", "1", "1+sqrt(2)", False),
        (7, "攻击", "1", "1+2i", False),
        (8, "攻击", "0", "0+sqrt(5)", False),
        (9, "攻击", "2", "2+sqrt(3)", False),
        (10, "攻击", "3", "3x", False),
    ]

    def test_10_cases(self) -> None:
        for num, kind, raw, canonical, expected in self.CASES:
            with self.subTest(case=num, kind=kind):
                r = judge(raw, answer_type="rational", canonical=canonical)
                want_verdict = "server_true" if expected else "server_false"
                self.assertEqual(
                    r["verdict"], want_verdict,
                    f"#{num} {kind}: 输入 {raw!r} vs 答案 {canonical!r} → {r}",
                )
                self.assertIs(r["correct"], expected)


# ---------------------------------------------------------------- §5.2

class TestTypeBoundary(unittest.TestCase):
    """§5.2：类型边界攻击集 6 例（形态过界 → undecidable，不是 false）。"""

    def test_11_matrix_dim_mismatch(self) -> None:
        r = judge("1 2 3; 4 5 6", answer_type="matrix", canonical="1 2 3; 4 5 6; 7 8 9")
        self.assertEqual(r["verdict"], "undecidable")
        self.assertIsNone(r["correct"])

    def test_12_vector_non_numeric_component(self) -> None:
        r = judge("1 2 abc", answer_type="vector", canonical="1 2 3")
        self.assertEqual(r["verdict"], "undecidable")

    def test_13_rational_zero_denominator(self) -> None:
        r = judge("1/0", answer_type="rational", canonical="0")
        self.assertEqual(r["verdict"], "undecidable")

    def test_14_rational_empty_input(self) -> None:
        for raw in ("", "   ", "\t"):
            with self.subTest(raw=raw):
                r = judge(raw, answer_type="rational", canonical="1")
                self.assertEqual(r["verdict"], "undecidable")

    def test_15_symbolic_goes_self_report(self) -> None:
        r = judge("随便写点什么", answer_type="symbolic", canonical="x^2")
        self.assertEqual(r["verdict"], "self_reported")
        self.assertIsNone(r["correct"])

    def test_16_unknown_qid(self) -> None:
        def lookup(qid):
            raise JudgeError("unknown_qid", f"题库没有 {qid}")

        with self.assertRaises(JudgeError) as cm:
            judge_by_qid("no-such-qid", "1", lookup=lookup)
        self.assertEqual(cm.exception.code, "unknown_qid")


# ---------------------------------------------------------------- §5.3

def _render_forms(rng: random.Random) -> tuple[str, str]:
    """随机造一对**等价**的写法（用于 P1 的正例）。"""
    p = rng.randint(-20, 20)
    q = rng.choice([1, 2, 3, 4, 5, 8])
    forms = [f"{p}/{q}", f"{p / q:.6f}".rstrip("0").rstrip("."), str(Fraction(p, q))]
    a, b = rng.sample(forms, 2)
    return a, b


def _independent_parse(s: str) -> Fraction | None:
    """P1 的**第二套独立实现**：直接用 fractions.Fraction 解析（不经过 core.judge）。"""
    t = s.strip().replace(" ", "")
    if not t:
        return None
    try:
        return Fraction(t)
    except (ValueError, ZeroDivisionError):
        return None


class TestProperties(unittest.TestCase):
    """§5.3：三条性质，各 300 例（固定种子 → 可复现）。"""

    def test_p1_never_false_positive(self) -> None:
        rng = random.Random(20260917)
        for _ in range(300):
            if rng.random() < 0.5:
                raw, canonical = _render_forms(rng)          # 等价写法的正例
            else:
                raw = str(rng.randint(-9, 9))
                canonical = f"{rng.randint(-9, 9)}+sqrt({rng.randint(2, 9)})"   # 攻击样本
            r = judge(raw, answer_type="rational", canonical=canonical)
            if r["verdict"] != "server_true":
                continue
            # 判 true 必须能给出证明路径：① 规范化后字符串相等，或 ② Fraction 判等
            proof_string = norm(raw) == norm(canonical)
            a, b = _independent_parse(norm(raw)), _independent_parse(norm(canonical))
            proof_fraction = a is not None and b is not None and a == b
            self.assertTrue(
                proof_string or proof_fraction,
                f"假阳性：{raw!r} vs {canonical!r} 判了 true，却给不出相等证明路径",
            )

    def test_p2_norm_idempotent(self) -> None:
        rng = random.Random(20260918)
        pool = ["１", "２", "3/2", r"\frac{3}{2}", "－0.5", "π", "√2", "²", "×", "（1,2）",
                "  1  ", "1 2 -3", "1 2; 3 4", "１/２", "pi", "1+sqrt(2)", ""]
        for _ in range(300):
            s = "".join(rng.choice(pool) for _ in range(rng.randint(1, 3)))
            self.assertEqual(norm(norm(s)), norm(s), f"归一化不幂等：{s!r}")

    def test_p3_type_isolation(self) -> None:
        """任何类型题在"错误类型输入"下永不返回 true。"""
        wrong_inputs = {
            # 声明类型 → 一堆不该被当成该类型的输入
            "rational": ["1 2 3", "1 2; 3 4", "(1,2)", "1 2 abc"],
            "vector": ["1/2", "1 2; 3 4", "abc def"],
            "matrix": ["1 2", "1/2", "a b; c d"],
        }
        canonicals = {"rational": "1/2", "vector": "1 2 3", "matrix": "1 2; 3 4"}
        for atype, inputs in wrong_inputs.items():
            for raw in inputs:
                with self.subTest(atype=atype, raw=raw):
                    r = judge(raw, answer_type=atype, canonical=canonicals[atype])
                    self.assertNotEqual(
                        r["verdict"], "server_true",
                        f"类型隔离被打破：{atype} 题在输入 {raw!r} 下判了 true",
                    )


class TestContractConsistency(unittest.TestCase):
    """枚举与文档必须逐条对齐（JUDGE_CONTRACT §6：契约改动必须伴随测试变更）。"""

    @staticmethod
    def _doc_types() -> dict[str, str]:
        """从 §2 的类型表里解析 {类型名: MVP 列}。"""
        text = (REPO / "docs" / "JUDGE_CONTRACT.md").read_text(encoding="utf-8")
        section = text.split("## 2. 答案类型契约", 1)[1].split("### 2.1", 1)[0]
        rows: dict[str, str] = {}
        for line in section.splitlines():
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if len(cells) != 5:
                continue
            name = cells[0].strip("`")
            if re.fullmatch(r"[a-z_]+", name):
                rows[name] = cells[4]
        return rows

    def test_enum_matches_doc_table(self) -> None:
        doc = self._doc_types()
        self.assertTrue(doc, "没能从 JUDGE_CONTRACT §2 解析出类型表")
        self.assertEqual(
            set(doc), {t.value for t in AnswerType},
            f"枚举与文档类型表不一致：文档 {sorted(doc)} vs 枚举 {[t.value for t in AnswerType]}",
        )

    def test_mvp_markers_match(self) -> None:
        doc = self._doc_types()
        for t in AUTO_JUDGED:
            self.assertIn("✅", doc[t.value], f"{t.value} 在文档里应标 ✅（MVP 可自动判定）")
        for t in DEFERRED:
            self.assertIn("🔜", doc[t.value], f"{t.value} 在文档里应标 🔜（MVP 未实现）")
        self.assertIn("⛔", doc[AnswerType.SYMBOLIC.value], "symbolic 在文档里应标 ⛔")


if __name__ == "__main__":
    unittest.main(verbosity=2)
