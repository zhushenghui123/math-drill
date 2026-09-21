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
    # 故意放一个**没有题**的章：栏目页要把它一起列出来（"这个学科还有哪些类型"的地图），
    # 顺序也必须按知识树序（kp 按 id 升序）而不是章名字典序。
    {"id": "l2n1", "title": "矩阵的运算", "chapter": "第九章 矩阵",
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
    def test_loaded_in_phase_1_with_its_rpcs(self) -> None:
        self.assertIn("modules/qbank", self.registry.loaded,
                      "qbank 必须被装载（ADR-017 把它从 P3 提前到 P1）")
        # 两个只读 + **一个写**（set_difficulty，ADR-018）—— 写动作只有这一个，
        # 将来再加写 rpc 必须先在 ADR 里过一遍（这里是"别偷偷加"的机械闸门）。
        self.assertEqual(sorted(self.registry.rpcs()["modules/qbank"]),
                         ["detail", "list", "set_difficulty"])

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

    # ---- 题目类型分组（= kp 的章；零题的章也要在，且按知识树序）
    def test_groups_are_chapters_and_keep_empty_ones(self) -> None:
        out = self.call("list", {"subject": "linear"})
        self.assertEqual([g["chapter"] for g in out["groups"]], ["第一章 行列式", "第九章 矩阵"],
                         "分组 = 章，顺序 = 知识树序（不是章名字典序）")
        self.assertEqual([g["total"] for g in out["groups"]], [1, 0], "零题的章照样列出来")
        self.assertEqual(out["groups"][1]["kids"][0]["kid"], "l2n1")
        self.assertEqual(out["groups"][0]["kids"][0]["title"], "行列式的性质与计算")

        # 分开的两个口径：score = 做对过的题÷题量；accuracy = 答对次数÷作答次数
        self.store.record_attempt(qid=Q2["id"], kid="l1n1",
                                  result={"verdict": "server_false", "correct": False})
        self.store.record_attempt(qid=Q2["id"], kid="l1n1",
                                  result={"verdict": "server_true", "correct": True})
        g = self.call("list", {"subject": "linear"})["groups"][0]
        self.assertEqual((g["attempts"], g["accuracy"], g["score"], g["coverage"]),
                         (2, 50, 100, 100))

        only = self.call("list", {"subject": "linear", "chapter": "第九章 矩阵"})
        self.assertEqual(only["items"], [], "章筛选：这个类型还没题")
        hit = self.call("list", {"subject": "linear", "chapter": "第一章 行列式"})
        self.assertEqual([i["qid"] for i in hit["items"]], [Q2["id"]])

    # ---- agent 定难度（ADR-018）
    def test_set_difficulty_overrides_base_and_keeps_origin(self) -> None:
        r = self.call("set_difficulty", {"qid": Q1["id"], "difficulty": 4,
                                         "reason": "要先配方再用夹逼", "src": "dsh"})
        self.assertTrue(r["ok"])
        self.assertEqual(r["difficultyBase"], 1, "返回里要能看到题库原生值做对照")

        it = self.call("list", {"subject": "calculus"})["items"][0]
        self.assertEqual((it["difficulty"], it["difficultyBase"], it["difficultySource"]), (4, 1, "agent"))
        self.assertEqual(it["difficultyReason"], "要先配方再用夹逼")

        # **最新一条为准**（append-only，不覆盖历史）
        self.call("set_difficulty", {"qid": Q1["id"], "difficulty": 2})
        got = self.call("detail", {"qid": Q1["id"]})["question"]
        self.assertEqual(got["difficulty"], 2)
        self.assertEqual(got["difficultyBase"], 1)
        # 题库原生那一列**没被动过**（重灌题库不该抹掉 agent 的判定）
        base = self.store.conn.execute(
            "SELECT difficulty FROM questions WHERE id = ?", (Q1["id"],)).fetchone()[0]
        self.assertEqual(base, 1)
        self.assertEqual(len(self.store.latest_difficulties()), 1, "同一题只保留最新一条生效值")

    def test_set_difficulty_rejects_bad_input(self) -> None:
        for bad, why in (({"qid": Q1["id"], "difficulty": 9}, "越界"),
                         ({"qid": Q1["id"], "difficulty": "难"}, "不是整数"),
                         ({"qid": Q1["id"]}, "缺 difficulty")):
            with self.assertRaises(ValueError, msg=why):
                self.call("set_difficulty", bad)
        with self.assertRaises(KeyError):
            self.call("set_difficulty", {"qid": "不存在的题", "difficulty": 2})


if __name__ == "__main__":
    unittest.main()
