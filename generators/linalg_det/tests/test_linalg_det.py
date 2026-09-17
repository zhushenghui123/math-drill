"""generators/linalg_det/tests/test_linalg_det.py —— 题源自测（T6 验收）。

性质（对应 BRIEF T6 验收条款）：
  ① 可复现门：同 seed 同输出；不同 seed 输出不同
  ② 数量与字段：≥40 题、§3.1 字段齐全、id 唯一且 == hash(gen_params)
  ③ **答案正确性**：每题用第二套算法独立复算（generator 内部已互证，这里再独立算一遍）
  ④ 分布合理：难度 1-4 全覆盖、kid 落在第八章的三个考点内
"""

from __future__ import annotations

import hashlib
import json
import sys
import unittest
from fractions import Fraction
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO))

from core.exact import det, det_bareiss  # noqa: E402
from generators.linalg_det.generator import FAMILIES, KIDS, generate  # noqa: E402

REQUIRED_FIELDS = ("id", "bundle_version", "kid", "type", "answer_type", "stem",
                   "answer", "difficulty", "gen_params", "source")


class TestLinalgDet(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.qs = generate(seed=20260917, per_family=6)

    def test_01_count_and_fields(self) -> None:
        self.assertGreaterEqual(len(self.qs), 40, "Phase 1 要求 ≥40 题")
        for q in self.qs:
            for f in REQUIRED_FIELDS:
                self.assertIn(f, q, f"{q.get('id')} 缺字段 {f}")
            self.assertEqual(q["source"], "generated")
            self.assertEqual(q["answer_type"], "rational")
            self.assertIn(q["type"], ("blank", "choice"))
            self.assertIn(q["difficulty"], (1, 2, 3, 4))

    def test_02_ids_stable_and_unique(self) -> None:
        ids = [q["id"] for q in self.qs]
        self.assertEqual(len(ids), len(set(ids)), "id 必须唯一")
        for q in self.qs:
            gp = json.loads(q["gen_params"])
            expect = "lin.det." + hashlib.sha1(
                json.dumps({"family": gp["family"], "kid": gp["kid"], "params": gp["params"]},
                           sort_keys=True, ensure_ascii=False).encode("utf-8")
            ).hexdigest()[:12]
            self.assertEqual(q["id"], expect, "id 必须等于 hash(gen_params)")

    def test_03_reproducible_same_seed(self) -> None:
        again = generate(seed=20260917, per_family=6)
        self.assertEqual(json.dumps(self.qs, sort_keys=True),
                         json.dumps(again, sort_keys=True), "同 seed 必须同输出")

    def test_04_different_seed_differs(self) -> None:
        other = generate(seed=20260918, per_family=6)
        self.assertNotEqual([q["id"] for q in self.qs], [q["id"] for q in other])

    def test_05_answers_independently_verified(self) -> None:
        """独立复算：不看 generator 的结论，直接按参数重算一遍。"""
        for q in self.qs:
            gp = json.loads(q["gen_params"])
            fam, params = gp["family"], gp["params"]
            with self.subTest(qid=q["id"], family=fam):
                if fam == "cramer":
                    a, b, c, d = params["a"], params["b"], params["c"], params["d"]
                    b1, b2 = params["b1"], params["b2"]
                    x1 = Fraction(det_bareiss([[b1, b], [b2, d]]), det_bareiss([[a, b], [c, d]]))
                    self.assertEqual(Fraction(q["answer"]), x1)
                    continue
                M = params.get("verify_matrix") or params.get("M")
                self.assertIsNotNone(M, f"{q['id']} 没有可复算的矩阵")
                # 两套算法都得一致，再与答案比
                self.assertEqual(det(M), det_bareiss(M))
                if q["type"] == "blank":
                    self.assertEqual(Fraction(q["answer"]), det(M))
                else:
                    opts = {o["k"]: o["t"] for o in json.loads(q["options"])}
                    self.assertEqual(Fraction(opts[q["answer"]]), det(M))

    def test_06_distribution(self) -> None:
        fams = {json.loads(q["gen_params"])["family"] for q in self.qs}
        self.assertEqual(fams, {name for name, _ in FAMILIES})
        self.assertEqual({q["kid"] for q in self.qs}, set(KIDS.values()))
        self.assertEqual({q["difficulty"] for q in self.qs}, {1, 2, 3, 4})
        self.assertTrue(any(q["type"] == "choice" for q in self.qs), "应含选择题")


if __name__ == "__main__":
    unittest.main(verbosity=2)
