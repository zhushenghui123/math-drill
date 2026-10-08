"""tests/test_coach_module.py —— agent 复盘/评分写回（ADR-023）的行为契约。

锁住五件事：
  1. `note` 落一条（带 `user_id`）· `list` 按题读回；
  2. **按人隔离**：甲的评语乙看不到、乙的甲也看不到（个人类），互不串；
  3. 校验从严：类型白名单（`practiceable` 不在其列）· `summary` 必填且 ≤500 · `reason` ≤500 ·
     题不存在 404；
  4. **attempt 归属**：给**别人的**作答写评语 ⇒ 400（防张冠李戴）；
  5. 这条路径**不碰 `questions`**：`answer_type` / `stem` / `difficulty` 一个字没变（ADR-013/020 的红线）。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from core.store import Store  # noqa: E402
from modules.coach.module import MAX_SUMMARY, on_request  # noqa: E402


class CoachCase(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.store = Store(self._tmp.name)
        self.store.load_questions([{
            "id": "q1", "bundle_version": None, "kid": None, "type": "blank",
            "answer_type": "self_report", "stem": "题干", "options": None,
            "answer": "占位", "analysis": "书上解答", "difficulty": None,
            "gen_params": None, "source": "test",
        }])

    def tearDown(self):
        self.store.close()
        self._tmp.cleanup()

    def test_01_write_and_read_back(self):
        out = on_request("note", {"qid": "q1", "kind": "grade", "summary": "思路对，漏判别式",
                                  "reason": "解答第 3 步", "_user": "alice"}, self.store)
        self.assertTrue(out["ok"])
        self.assertEqual(out["user"], "alice")
        got = on_request("list", {"qid": "q1", "_user": "alice"}, self.store)
        self.assertEqual(got["n"], 1)
        self.assertEqual(got["notes"][0]["summary"], "思路对，漏判别式")
        self.assertEqual(got["notes"][0]["kind"], "grade")

    def test_02_per_user_isolation(self):
        on_request("note", {"qid": "q1", "kind": "review", "summary": "甲的复盘", "_user": "alice"}, self.store)
        on_request("note", {"qid": "q1", "kind": "review", "summary": "乙的复盘", "_user": "bob"}, self.store)
        a = on_request("list", {"qid": "q1", "_user": "alice"}, self.store)["notes"]
        b = on_request("list", {"qid": "q1", "_user": "bob"}, self.store)["notes"]
        self.assertEqual([n["summary"] for n in a], ["甲的复盘"])
        self.assertEqual([n["summary"] for n in b], ["乙的复盘"])

    def test_03_validation(self):
        with self.assertRaises(ValueError):          # practiceable 是数据管线的，不许从这里写
            on_request("note", {"qid": "q1", "kind": "practiceable", "summary": "x"}, self.store)
        with self.assertRaises(ValueError):          # summary 必填
            on_request("note", {"qid": "q1", "kind": "grade"}, self.store)
        with self.assertRaises(ValueError):          # summary 超长
            on_request("note", {"qid": "q1", "kind": "grade", "summary": "x" * (MAX_SUMMARY + 1)}, self.store)
        with self.assertRaises(ValueError):          # reason 超长
            on_request("note", {"qid": "q1", "kind": "grade", "summary": "x", "reason": "y" * 501}, self.store)
        with self.assertRaises(KeyError):            # 题不存在
            on_request("note", {"qid": "ghost", "kind": "grade", "summary": "x"}, self.store)
        with self.assertRaises(ValueError):          # qid 类型
            on_request("note", {"qid": 7, "kind": "grade", "summary": "x"}, self.store)

    def test_04_attempt_must_belong_to_the_same_user(self):
        aid = self.store.record_attempt(qid="q1", kid=None,
                                        result={"verdict": "server_true", "correct": True},
                                        user="alice")
        ok = on_request("note", {"qid": "q1", "kind": "grade", "summary": "写给自己那条",
                                 "attempt_id": aid, "_user": "alice"}, self.store)
        self.assertTrue(ok["ok"])
        with self.assertRaises(ValueError):          # 乙想给甲的作答写评语 ⇒ 400
            on_request("note", {"qid": "q1", "kind": "grade", "summary": "越界",
                                "attempt_id": aid, "_user": "bob"}, self.store)
        with self.assertRaises(ValueError):          # attempt_id 类型
            on_request("note", {"qid": "q1", "kind": "grade", "summary": "x",
                                "attempt_id": "3", "_user": "alice"}, self.store)

    def test_05_does_not_touch_questions(self):
        before = dict(self.store.conn.execute(
            "SELECT answer_type, stem, analysis, difficulty FROM questions WHERE id='q1'").fetchone())
        on_request("note", {"qid": "q1", "kind": "grade", "summary": "评语", "_user": "alice"}, self.store)
        after = dict(self.store.conn.execute(
            "SELECT answer_type, stem, analysis, difficulty FROM questions WHERE id='q1'").fetchone())
        self.assertEqual(before, after, "写复盘不许碰 questions（判分依据不动）")


if __name__ == "__main__":
    unittest.main()
