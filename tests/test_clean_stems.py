"""tests/test_clean_stems.py —— 语料题面清洗器的行为契约（`scripts/clean_stems.py`）。

锁的是 **2026-09-24 实测到的六类噪声**，每条都对应真实样本（详见脚本 docstring）：
  ① `<eq>…</eq>` → `$…$`（前端不认 `<eq>`，会原样显示标签）
  ② HTML 表格标签 → 分隔符（**不许直接删**，否则 `0.1|0.6|0.3` 变成 `0.10.60.3`）
  ③ 水印 `公众号:考研讲课328`
  ④ 页眉 `<页码>第X章 章名(+§N 节名)`
  ⑤ `[NO TEXT]` 占位与零星乱码
  ⑥ `$` 配对不平衡 ⇒ 整条剥掉（交前端 autoLatex 包）

刻意留了两条**反向断言**（防误伤）：
  - 数学里的 `i<n` / `x<y` **不许**被当成 HTML 标签删掉（泛化标签正则的具体表现就是它）；
  - 章名白名单里 `向量代数与空间解析几何` 的整条匹配 —— 手抄名单漏过它一次，
    结果 `33第八章 向量代数与空间解析几何` 只被删掉前半（`向量` 先命中），留下 `代数与空间解析几何`。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

from clean_stems import CHAPTERS, SECTIONS, clean_bank, clean_text  # noqa: E402


class CleanTextCase(unittest.TestCase):
    def test_eq_math_becomes_dollar(self):
        s, fired = clean_text("设 <eq>X_i</eq> 与 <eq>\\frac{1}{2}</eq> 独立")
        self.assertEqual(s, "设 $X_i$ 与 $\\frac{1}{2}$ 独立")
        self.assertIn("eq_math", fired)

    def test_eq_math_multiline_uses_display_dollars(self):
        s, _ = clean_text("<eq>\\begin{array}{l}\na & b\n\\end{array}</eq>")
        self.assertTrue(s.startswith("$$"), s)
        self.assertTrue(s.endswith("$$"), s)

    def test_table_keeps_separators(self):
        """表格：单元格留 ` | `、行留换行 —— 关键是**数字不许粘连**。"""
        s, fired = clean_text(
            "分布列为<table><tr><td>P</td><td>0.1</td><td>0.6</td></tr>"
            "<tr><td>Q</td><td>0.3</td><td>0.4</td></tr></table>求 E(X)")
        self.assertNotIn("<table", s)
        self.assertNotIn("<td", s)
        self.assertIn("P | 0.1 | 0.6", s)
        self.assertIn("Q | 0.3 | 0.4", s)
        self.assertIn("\n", s)
        self.assertIn("table_cell", fired)
        self.assertIn("table_tag", fired)

    def test_less_than_in_math_is_not_a_tag(self):
        """反向断言：数学里的 `i<n` 不能被当标签删掉。"""
        for raw in ("对所有 i<n 成立", "当 x<y 时", "sum_{i<n} a_i"):
            s, fired = clean_text(raw)
            self.assertEqual(s, raw, f"{raw!r} 被改了：{s!r}")
            self.assertNotIn("table_tag", fired)

    def test_watermark_and_glued_page_number(self):
        s, fired = clean_text("求下列各微分方程的通解: 公众号:考研讲课328第六节 高阶线性微分方程(1) y'' = x")
        self.assertNotIn("公众号", s)
        self.assertNotIn("328", s)
        self.assertTrue(s.endswith("(1) y'' = x"), s)
        self.assertIn("watermark", fired)

    def test_page_header_removed_whole(self):
        """整条页眉（页码 + 第X章 + 章名）必须被整体删掉。"""
        s, fired = clean_text("交线平行且过点 (-3,2,5) 的33第八章 向量代数与空间解析几何直线的方程.")
        self.assertEqual(s, "交线平行且过点 (-3,2,5) 的直线的方程.")
        self.assertIn("page_header", fired)

    def test_page_header_with_section_marker(self):
        s, _ = clean_text("可见30第一章随机事件及其概率§6.综合提高")
        self.assertEqual(s, "可见综合提高")

    def test_book_header_removed(self):
        s, _ = clean_text("讨论 f(x) 的连续性.[NO TEXT]23吉米多维奇高等数学习题精选精解")
        self.assertEqual(s, "讨论 f(x) 的连续性.")

    def test_no_text_marker_and_misc(self):
        s, fired = clean_text("经验证,答案为(A).[NO TEXT]周理")
        self.assertEqual(s, "经验证,答案为(A).")
        self.assertIn("no_text_marker", fired)
        self.assertIn("misc_artifact", fired)

    def test_unbalanced_dollar_is_stripped(self):
        s, fired = clean_text("求 P(B$|\\overline{A}) 的值")
        self.assertEqual(s.count("$"), 0)
        self.assertIn("unbalanced_math", fired)

    def test_balanced_dollar_kept(self):
        raw = "设 $x>0$ 且 $y<1$"
        s, fired = clean_text(raw)
        self.assertEqual(s, raw)
        self.assertNotIn("unbalanced_math", fired)

    def test_idempotent(self):
        raw = "计算曲面积分353吉米多维奇高等数学习题精选精解I = \\iint 1"
        once, _ = clean_text(raw)
        twice, fired = clean_text(once)
        self.assertEqual(once, twice)
        self.assertEqual(fired, [])


class CleanBankCase(unittest.TestCase):
    def test_clean_bank_writes_flags_and_stats(self):
        bank = {"bank": "b", "questions": [
            {"qid": "q1", "stem": "题面[NO TEXT]", "solution": "解析 公众号:考研讲课"},
            {"qid": "q2", "stem": "干净题面", "solution": "干净解析"},
        ]}
        out = clean_bank(bank)
        self.assertEqual(out["questions"][0]["stem"], "题面")
        self.assertEqual(out["questions"][0]["solution"], "解析")
        self.assertEqual(out["questions"][1]["stem"], "干净题面")
        self.assertTrue(any(f.startswith("cleaned:stem:") for f in out["questions"][0]["flags"]))
        self.assertTrue(any(f.startswith("cleaned:solution:") for f in out["questions"][0]["flags"]))
        self.assertEqual(out["report"]["clean_changed_questions"], 1)  # 只数"题面被改"的
        self.assertIn("stem.no_text_marker", out["report"]["clean_stats"])
        self.assertIn("solution.watermark", out["report"]["clean_stats"])

    def test_wordlist_has_no_prefix_trap(self):
        """白名单里短的条目不能屏蔽长的条目（历史上正是 `向量` 吃掉了 `向量代数与空间解析几何`）。"""
        self.assertIn("向量代数与空间解析几何", CHAPTERS)
        s, _ = clean_text("88第八章 向量代数与空间解析几何的方程")
        self.assertEqual(s, "的方程")

    def test_wordlists_sorted_and_unique(self):
        for name, items in (("CHAPTERS", CHAPTERS), ("SECTIONS", SECTIONS)):
            self.assertEqual(len(set(items)), len(items), f"{name} 有重复")
            self.assertTrue(all(isinstance(x, str) and x.strip() for x in items), name)


if __name__ == "__main__":
    unittest.main()
