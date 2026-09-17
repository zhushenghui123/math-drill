"""tests/test_store.py —— [T2] 持久层验收（规格：ADR-002 + ARCHITECTURE §3.5 / ADR-007）。

覆盖四组：
  1. 建表与 schema_version（本文件是唯一归属；模块不得建表）
  2. blob：原子写 + 重启不丢 + 版本仲裁（冲突 409 语义 = ConflictError 带最新 blob）
  3. 合并规则：newer-wins / settings 服务端为真相源 / attempts 退役出 blob
  4. attempts 独占写入（I5）：只收 judge 判决；客户端无法直接提交 correct
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

from core.store import SCHEMA_VERSION, ConflictError, Store  # noqa: E402


class TestSchema(unittest.TestCase):
    def test_schema_created_with_version(self) -> None:
        with TemporaryDirectory() as d:
            s = Store(d)
            self.assertEqual(s.schema_version, SCHEMA_VERSION)
            names = {r["name"] for r in s.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
            for t in ("meta", "questions", "kp", "attempts"):
                self.assertIn(t, names, f"缺表 {t}")
            s.close()


class TestBlob(unittest.TestCase):
    def test_restart_keeps_data(self) -> None:
        with TemporaryDirectory() as d:
            s = Store(d)
            blob = s.put_blob(0, {"cards": {"a": {"updated_at": 1, "v": "x"}}})
            self.assertEqual(blob["server_version"], 1)
            s.close()
            s2 = Store(d)                      # 模拟进程重启
            again = s2.get_blob()
            self.assertEqual(again["server_version"], 1)
            self.assertEqual(again["data"]["cards"]["a"]["v"], "x")
            s2.close()

    def test_version_mismatch_raises_with_latest(self) -> None:
        with TemporaryDirectory() as d:
            s = Store(d)
            s.put_blob(0, {"cards": {"a": {"updated_at": 1}}})       # → v1
            with self.assertRaises(ConflictError) as cm:
                s.put_blob(0, {"cards": {"a": {"updated_at": 2}}})   # 用过期版本再写
            self.assertEqual(cm.exception.latest["server_version"], 1)
            self.assertEqual(s.get_blob()["server_version"], 1, "冲突不得改变服务端版本")
            s.close()

    def test_newer_wins_by_updated_at(self) -> None:
        with TemporaryDirectory() as d:
            s = Store(d)
            s.put_blob(0, {"daily": {"updated_at": 100, "v": "old"}})
            s.put_blob(1, {"daily": {"updated_at": 50, "v": "stale"}})   # 更旧 → 应被忽略
            self.assertEqual(s.get_blob()["data"]["daily"]["v"], "old")
            s.put_blob(2, {"daily": {"updated_at": 200, "v": "new"}})    # 更新 → 胜出
            self.assertEqual(s.get_blob()["data"]["daily"]["v"], "new")
            s.close()

    def test_settings_server_authoritative(self) -> None:
        with TemporaryDirectory() as d:
            s = Store(d)
            s.put_settings(0, {"theme": "dark"})
            s.put_blob(1, {"settings": {"theme": "light"}, "cards": {}})  # 整块 PUT 不得改 settings
            self.assertEqual(s.get_blob()["data"]["settings"]["theme"], "dark")
            s.put_settings(2, {"theme": "light"})                         # 显式 PUT 才生效
            self.assertEqual(s.get_blob()["data"]["settings"]["theme"], "light")
            s.close()

    def test_attempts_retired_from_blob(self) -> None:
        with TemporaryDirectory() as d:
            s = Store(d)
            s.put_blob(0, {"attempts": [{"id": 1, "correct": 1}], "cards": {}})
            self.assertNotIn("attempts", s.get_blob()["data"], "attempts 不得进 blob（ADR-007）")
            s.close()

    def test_two_device_conflict_flow(self) -> None:
        """双设备模拟：A 先写成功；B 拿旧 base_version 写 → 409 语义（ConflictError 带最新）。"""
        with TemporaryDirectory() as d:
            s = Store(d)
            base = s.get_blob()["server_version"]          # 两台设备都拿到 v0
            s.put_blob(base, {"cards": {"devA": {"updated_at": 10}}})
            with self.assertRaises(ConflictError) as cm:
                s.put_blob(base, {"cards": {"devB": {"updated_at": 20}}})
            latest = cm.exception.latest
            self.assertEqual(latest["server_version"], 1)
            self.assertIn("devA", latest["data"]["cards"])   # 客户端拿最新重放
            s.close()


class TestAttempts(unittest.TestCase):
    def _result(self, verdict: str, correct=None) -> dict:
        return {"verdict": verdict, "correct": correct, "canonical": "1", "answer_type": "rational",
                "detail": {"reason": "test", "accepted_forms": []}}

    def test_only_judge_output_accepted(self) -> None:
        with TemporaryDirectory() as d:
            s = Store(d)
            with self.assertRaises(ValueError):
                s.record_attempt(qid="q1", kid="c1n1", result={"correct": True})   # 客户端直接提交结论
            s.close()

    def test_correct_derived_from_verdict(self) -> None:
        with TemporaryDirectory() as d:
            s = Store(d)
            s.record_attempt(qid="q1", kid="c1n1", result=self._result("server_true", True))
            s.record_attempt(qid="q2", kid="c1n1", result=self._result("server_false", False))
            s.record_attempt(qid="q3", kid="c1n1", result=self._result("undecidable"))
            rows = s.list_attempts()
            self.assertEqual([r["correct"] for r in rows], [1, 0, None])
            self.assertEqual([r["verdict"] for r in rows],
                             ["server_true", "server_false", "undecidable"])
            s.close()

    def test_self_report_needs_user_verdict(self) -> None:
        with TemporaryDirectory() as d:
            s = Store(d)
            with self.assertRaises(ValueError):
                s.record_attempt(qid="q1", kid=None, result={"verdict": "self_reported"})
            s.record_attempt(qid="q1", kid=None,
                             result=self._result("self_reported", True))
            self.assertEqual(s.list_attempts()[0]["correct"], 1)
            s.close()

    def test_server_side_timestamp_and_durability(self) -> None:
        with TemporaryDirectory() as d:
            before = time.time()
            s = Store(d)
            s.record_attempt(qid="q1", kid=None, result=self._result("server_true", True),
                             user_ms=1234, device="phone")
            s.close()
            s2 = Store(d)
            rows = s2.list_attempts()
            self.assertEqual(len(rows), 1, "重启后 attempts 不丢")
            self.assertGreaterEqual(rows[0]["ts"], before)
            self.assertLessEqual(rows[0]["ts"], time.time() + 1)
            self.assertEqual(rows[0]["user_ms"], 1234)
            self.assertEqual(rows[0]["device"], "phone")
            s2.close()


class TestQuestions(unittest.TestCase):
    def test_load_and_lookup(self) -> None:
        with TemporaryDirectory() as d:
            s = Store(d)
            n = s.load_questions([
                {"id": "linalg.det.3x3.a", "answer_type": "rational", "answer": "-3",
                 "kid": "c1n1", "difficulty": 2, "type": "blank", "source": "generated",
                 "bundle_version": 1, "gen_params": '{"seed":1}', "stem": "求行列式",
                 "options": None, "analysis": None},
            ])
            self.assertEqual(n, 1)
            self.assertEqual(s.question_count(), 1)
            self.assertEqual(s.get_question("linalg.det.3x3.a"), ("rational", "-3"))
            self.assertIsNone(s.get_question("nope"))
            s.load_kp([{"id": "c1n1", "title": "行列式", "chapter": "c1", "subject": "linalg",
                        "exam": "all", "related": None}])
            self.assertEqual(s.kp_count(), 1)
            s.close()

    def test_question_rows_are_valid_json_ish(self) -> None:
        """灌库的 json 字段必须能被 json.loads 回去（防止半截数据入表）。"""
        with TemporaryDirectory() as d:
            s = Store(d)
            s.load_questions([{"id": "x", "answer_type": "rational", "answer": "1",
                               "gen_params": json.dumps({"seed": 7})}])
            row = s.conn.execute("SELECT gen_params FROM questions WHERE id='x'").fetchone()
            self.assertEqual(json.loads(row["gen_params"]), {"seed": 7})
            s.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
