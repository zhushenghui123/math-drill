"""tests/test_kp_parse.py —— 考点树 → kp 表的解析（`scripts/db_init.py` 的 parse_kp_js）。

为什么要单独测这一层：kp 的 `subject` 是**题库分类的唯一依据**（栏目页按它分学科、
题库模块按它聚合）。这里错一个字，题目就会出现在别的学科里 —— 而且是**静默**的：
2026-09-21 实测过一次，`CATEGORY_RE` 写死 `probability` 而知识树里是 `prob`，
结果概率的 34 个考点全被归到「线性代数」名下，谁也没发现（因为没人按 subject 查过）。

本文件按**真实知识树文件**断言，不是造数据 —— 树里改了 id 就会红。
"""

from __future__ import annotations

import sys
import unittest
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from scripts.db_init import parse_kp_js  # noqa: E402

TREE = REPO / "web" / "js" / "data-knowledge.js"


class KpParseCase(unittest.TestCase):
    def setUp(self) -> None:
        self.rows = parse_kp_js(TREE)
        self.by_subject = Counter(r["subject"] for r in self.rows)

    def test_three_subjects_all_parsed(self) -> None:
        """三个分类一个都不能少 —— 少一个说明 CATEGORY_RE 又和知识树对不上了。"""
        self.assertEqual(set(self.by_subject), {"calculus", "linear", "prob"},
                         f"实际解析到的 subject：{dict(self.by_subject)}")

    def test_probability_nodes_are_not_folded_into_linear(self) -> None:
        """概率的章节不能挂在 linear 名下（这正是踩过的那一脚）。"""
        prob_chapters = {r["chapter"] for r in self.rows if r["subject"] == "prob"}
        linear_chapters = {r["chapter"] for r in self.rows if r["subject"] == "linear"}
        self.assertIn("第十四章 随机事件与概率", prob_chapters)
        self.assertFalse(prob_chapters & linear_chapters, "同一章的 subject 不许分裂")
        self.assertNotIn("第十四章 随机事件与概率", linear_chapters)

    def test_total_and_ids_are_unique(self) -> None:
        self.assertEqual(len(self.rows), 68, "知识树共 68 个考点")
        ids = [r["id"] for r in self.rows]
        self.assertEqual(len(ids), len(set(ids)), "考点 id 必须唯一")

    def test_every_row_has_subject_and_chapter(self) -> None:
        for r in self.rows:
            self.assertTrue(r["subject"], f"{r['id']} 没有 subject")
            self.assertTrue(r["chapter"], f"{r['id']} 没有 chapter")
            self.assertTrue(r["title"], f"{r['id']} 没有 title")


if __name__ == "__main__":
    unittest.main()
