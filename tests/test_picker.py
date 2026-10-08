"""tests/test_picker.py —— 选题器的六条性质（占位文件到这里才真正落地）。

被钉住的是 `modules/picker/module.py::pick`（P2b）：**按天确定 · 跨章铺开 · 先新后旧 ·
错题回炉有额度 · 不交白卷 · 不重复**。
第 2 条带反例对照：被替换掉的旧实现（按日期哈希取**连续**切片）在这一条上必红 —— 8 题挤在同一章。
"""

from __future__ import annotations

import sys
import unittest
from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from core.picker import REVIEW_RATIO, pick  # noqa: E402
import modules.picker.module as picker_module  # 门面：算法在 core，模块再导出


def _pool(chapters: int = 6, per_chapter: int = 20) -> tuple[list[dict], dict]:
    """造一个多章的练习池：第 i 章有 `per_chapter` 道题（kid = `ki`）。"""
    rows, kp = [], {}
    for i in range(chapters):
        kid = f"k{i}"
        kp[kid] = {"chapter": f"第{i + 1}章", "subject": "linear"}
        for j in range(per_chapter):
            rows.append({"id": f"q{i}-{j}", "kid": kid})
    return rows, kp


class PickerPropertyCase(unittest.TestCase):
    def test_01_same_day_is_deterministic(self):
        rows, kp = _pool()
        a = pick(rows, stats={}, kp=kp, limit=8, today=date(2026, 10, 8))
        b = pick(rows, stats={}, kp=kp, limit=8, today=date(2026, 10, 8))
        c = pick(rows, stats={}, kp=kp, limit=8, today=date(2026, 10, 9))
        self.assertEqual([r["id"] for r in a], [r["id"] for r in b], "同一天必须同一批")
        self.assertNotEqual([r["id"] for r in a], [r["id"] for r in c], "换一天应当换一批")

    def test_02_spreads_across_chapters(self):
        rows, kp = _pool(chapters=6, per_chapter=20)
        got = pick(rows, stats={}, kp=kp, limit=8, today=date(2026, 10, 8))
        seen = sorted({kp[r["kid"]]["chapter"] for r in got})
        self.assertEqual(len(got), 8)
        self.assertGreaterEqual(len(seen), 4, f"8 题至少铺开到 4 个章，实际 {seen}")

    def test_03_prefers_undone(self):
        rows, kp = _pool(chapters=4, per_chapter=10)
        stats = {r["id"]: {"n": 1, "correct": 1} for r in rows[:8]}     # 8 题做过且做对
        got = pick(rows, stats=stats, kp=kp, limit=8, today=date(2026, 10, 8))
        self.assertTrue(all(r["id"] not in stats for r in got), "有没做过的题时不该选做对过的")

    def test_04_wrong_has_quota_but_exists(self):
        rows, kp = _pool(chapters=4, per_chapter=10)
        wrong = {r["id"]: {"n": 2, "correct": 0} for r in rows[:20]}    # 20 题错着
        got = pick(rows, stats=wrong, kp=kp, limit=8, today=date(2026, 10, 8))
        n_wrong = sum(1 for r in got if r["id"] in wrong)
        self.assertLessEqual(n_wrong, max(1, round(8 * REVIEW_RATIO)), "错题回炉不该挤满题单")
        self.assertGreaterEqual(n_wrong, 1, "有错题时至少回炉一道")

    def test_05_never_blank_when_pool_is_small(self):
        rows, kp = _pool(chapters=2, per_chapter=3)                     # 池子只有 6 题
        got = pick(rows, stats={r["id"]: {"n": 1, "correct": 1} for r in rows},
                   kp=kp, limit=8, today=date(2026, 10, 8))
        self.assertEqual(len(got), 6, "池子不够时宁可复习也不交白卷")

    def test_00_module_facade_reexports_same_implementation(self):
        """重排后钉住：模块是门面、不是第二份实现（两处 `pick` 必须是同一个函数对象）。"""
        self.assertIs(picker_module.pick, pick)
        self.assertEqual(picker_module.REVIEW_RATIO, REVIEW_RATIO)

    def test_06_no_duplicates_and_edge_cases(self):
        rows, kp = _pool(chapters=3, per_chapter=5)
        got = pick(rows, stats={}, kp=kp, limit=15, today=date(2026, 10, 8))
        ids = [r["id"] for r in got]
        self.assertEqual(len(ids), len(set(ids)), "不许重复")
        self.assertEqual(pick(rows, stats={}, kp=kp, limit=0), [])
        self.assertEqual(pick([], stats={}, kp={}, limit=8), [])


if __name__ == "__main__":
    unittest.main()
