"""tests/test_qbank_module.py —— 题库浏览模块验收（规格：ADR-017）。

三条被测性质（都不依赖 HTTP）：
  1. **装载**：`modules/qbank` 在 Phase 1 就被装载（phase 字段从 P3 提前），
     且 `rpc` 恰好是 list/detail —— 真相来自装载器，本文件不自己读 manifest。
  2. **不回答案**：`list` / `detail` 的输出里**结构上**没有 answer/analysis
     （列白名单在 `Store._VIEW_COLS`，本用例是那条白名单的外部证人）。
  3. **指标定义**：完成度 = 做过的题 ÷ 总题数；综合评分 = 做对过的题 ÷ 总题数
     （定义写死在 module.py 顶部，改定义必须同时改这里 —— 故意的双写）。
"""

from __future__ import annotations

import json
import sys
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from core.registry import Registry  # noqa: E402
from core.store import Store  # noqa: E402

Q1 = {"id": "imp.tjq1.s1-6.q1-3", "kid": "c1n2", "type": "blank", "answer_type": "rational",
      "stem": r"求 $\lim_{x\to 0}\frac{\sin 2x}{\sin 5x}$", "answer": "2/5",
      "analysis": "等价无穷小：分子分母同阶", "difficulty": 1,
      "source": "ocr:tongji-quanjie-1 p27 习题1-6 1(3)"}
Q2 = {"id": "lin.det.a", "kid": "l1n1", "type": "blank", "answer_type": "rational",
      "stem": "计算二阶行列式", "answer": "82", "analysis": "ad-bc", "difficulty": 3,
      "source": "linalg_det"}
KP = [
    {"id": "c1n2", "title": "两个重要极限（一）", "chapter": "第一章 函数、极限与连续",
     "subject": "calculus", "exam": "all", "related": None},
    {"id": "l1n1", "title": "行列式的性质与计算", "chapter": "第一章 行列式",
     "subject": "linear", "exam": "all", "related": None},
]


class QBankCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.store = Store(self._tmp.name)
        self.addCleanup(self.store.close)
        self.store.load_kp(KP)
        self.store.load_questions([Q1, Q2])
        self.registry = Registry(REPO, phase="1")
        self.registry.load_all()

    def call(self, rpc: str, payload: dict) -> dict:
        return self.registry.dispatch("modules/qbank", rpc, payload, ctx=self.store)

    # ---- 1. 装载
    def test_loaded_in_phase_1_with_two_rpcs(self) -> None:
        self.assertIn("modules/qbank", self.registry.loaded,
                      "qbank 必须被装载（ADR-017 把它从 P3 提前到 P1）")
        self.assertEqual(sorted(self.registry.rpcs()["modules/qbank"]), ["detail", "list"])

    # ---- 2. 不回答案（结构保证）
    def test_list_carries_no_answer(self) -> None:
        out = self.call("list", {})
        blob = json.dumps(out, ensure_ascii=False)
        self.assertNotIn('"answer"', blob)
        self.assertNotIn('"analysis"', blob)
        self.assertNotIn(Q1["answer"], blob)
        self.assertNotIn(Q1["analysis"], blob)
        # 但**题面要给**：卡片要显示它（本轮实测就栽在这 —— 卡片当时退化成显示题号）
        self.assertEqual(out["items"][0]["stem"], Q1["stem"])
        self.assertTrue(all(i.get("stem") for i in out["items"]), "每张卡片都要有题面")

    def test_detail_carries_stem_but_no_answer(self) -> None:
        out = self.call("detail", {"qid": Q1["id"]})
        self.assertEqual(out["question"]["stem"], Q1["stem"], "题面要给")
        self.assertEqual(out["question"]["difficulty"], 1)
        blob = json.dumps(out, ensure_ascii=False)
        self.assertNotIn('"answer"', blob)
        self.assertNotIn('"analysis"', blob)
        self.assertNotIn(Q1["answer"], blob)

    # ---- 3. 指标定义（做过的题 / 做对过的题 ÷ 总题数）
    def test_metrics_definition(self) -> None:
        empty = self.call("list", {})
        calc = [s for s in empty["subjects"] if s["id"] == "calculus"][0]
        self.assertEqual((calc["total"], calc["done"], calc["mastered"]), (1, 0, 0))
        self.assertEqual((calc["coverage"], calc["score"]), (0, 0))

        # 判定的唯一入口是 core.judge；这里直接把判决喂给 store（模拟"做错一次"）
        self.store.record_attempt(qid=Q1["id"], kid="c1n2",
                                  result={"verdict": "server_false", "correct": False})
        after = self.call("list", {})
        calc = [s for s in after["subjects"] if s["id"] == "calculus"][0]
        self.assertEqual((calc["done"], calc["mastered"]), (1, 0))
        self.assertEqual((calc["coverage"], calc["score"], calc["accuracy"]), (100, 0, 0))

        self.store.record_attempt(qid=Q1["id"], kid="c1n2",
                                  result={"verdict": "server_true", "correct": True})
        ok = self.call("list", {})
        calc = [s for s in ok["subjects"] if s["id"] == "calculus"][0]
        self.assertEqual((calc["coverage"], calc["score"], calc["accuracy"]), (100, 100, 50))

    # ---- 筛选与日粒度
    def test_subject_filter_and_day_granularity(self) -> None:
        self.store.record_attempt(qid=Q2["id"], kid="l1n1",
                                  result={"verdict": "server_false", "correct": False})
        out = self.call("list", {"subject": "linear"})
        self.assertEqual([i["qid"] for i in out["items"]], [Q2["id"]])
        self.assertEqual(len(out["subjects"]), 2, "subjects 恒为全量（不受筛选影响）")
        self.assertTrue(out["items"][0]["done"])
        self.assertEqual(out["items"][0]["lastDay"], time.strftime("%Y-%m-%d"))

        # **做过的排前面**：两个学科一起看时，做完的那张不能被 48 张未做的压到列表尾部
        # （实测踩过：写成 `key=(i["done"], qid)` 时 False 先排，做完的沉底）
        both = self.call("list", {})
        self.assertTrue(both["items"][0]["done"], "列表首个必须是做过的那道")

        detail = self.call("detail", {"qid": Q2["id"]})
        self.assertTrue(detail["done"])
        self.assertFalse(detail["correct"], "只做错过 ⇒ correct=False")
        self.assertEqual(detail["attempts"][0]["day"], time.strftime("%Y-%m-%d"))
        self.assertNotIn("ts", detail["attempts"][0], "不给秒级时间戳")

    def test_done_filter_accepts_string_from_query(self) -> None:
        """`?done=false` 从查询串进来是**字符串** —— 不能被 `bool("false")` 当成 True。"""
        self.assertEqual(len(self.call("list", {"done": "false"})["items"]), 2)
        self.assertEqual(len(self.call("list", {"done": "true"})["items"]), 0)

    # ---- agent 复盘（只读）
    def test_notes_are_read_only_and_carry_provenance(self) -> None:
        self.store.record_note(qid=Q1["id"], kind="review_wrong",
                               summary="你把它当成极限不存在了。",
                               reason="等价无穷小只对乘除因子成立，加减不能直接换",
                               author="agent", src="offline")
        detail = self.call("detail", {"qid": Q1["id"]})
        self.assertEqual(len(detail["notes"]), 1)
        note = detail["notes"][0]
        self.assertEqual(note["kind"], "review_wrong")
        self.assertEqual(note["author"], "agent")
        self.assertEqual(note["src"], "offline", "谁写的、从哪来都要带出来")
        self.assertIn("reason", note)
        self.assertEqual(note["day"], time.strftime("%Y-%m-%d"))

    # ---- 未知题 / 未声明 rpc
    def test_unknown_qid_raises_keyerror(self) -> None:
        with self.assertRaises(KeyError):
            self.call("detail", {"qid": "不存在的题"})
        with self.assertRaises(KeyError):
            self.call("detail", {})
        with self.assertRaises(KeyError):
            self.call("nope", {})


if __name__ == "__main__":
    unittest.main()
