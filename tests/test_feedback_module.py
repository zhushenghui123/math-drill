"""tests/test_feedback_module.py —— 报错回流（ADR-022）的行为契约。

锁住四件事：
  1. `file` 落一条（含**归属**：谁报的）+ `list` 能取回；
  2. 校验从严：原因白名单（400）· 题必须存在（404）· 备注有上限（400）；
  3. `list` 的 status 白名单与 limit 上限（防把整个队列塞进上下文）；
  4. **防冒充**：`_user` 是保留键，bridge 必须在**合并入参之后**才写它
     （否则客户端可以在 body 里自带 `_user` 冒充别人）—— 这条用源码结构断言钉住。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from core.store import SCHEMA_VERSION, Store  # noqa: E402
from modules.feedback.module import KINDS, MAX_NOTE, on_request  # noqa: E402


class FeedbackCase(unittest.TestCase):
    def setUp(self):
        import tempfile
        self._tmp = tempfile.TemporaryDirectory()
        self.store = Store(self._tmp.name)
        self.store.load_questions([{
            "id": "q-test-1", "bundle_version": None, "kid": None, "type": "blank",
            "answer_type": "self_report", "stem": "题干", "options": None,
            "answer": "x", "analysis": None, "difficulty": None,
            "gen_params": None, "source": "test",
        }])

    def tearDown(self):
        self.store.close()
        self._tmp.cleanup()

    def test_01_file_and_list_with_attribution(self):
        out = on_request("file", {"qid": "q-test-1", "kind": "stem", "note": "少了个选项",
                                  "_user": "alice"}, self.store)
        self.assertTrue(out["ok"])
        self.assertEqual(out["kind"], "stem")
        self.assertEqual(out["status"], "open")
        rows = on_request("list", {}, self.store)["reports"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["qid"], "q-test-1")
        self.assertEqual(rows[0]["user_id"], "alice", "必须记得是谁报的")

    def test_02_validation_is_strict(self):
        with self.assertRaises(ValueError):                       # 原因不在白名单
            on_request("file", {"qid": "q-test-1", "kind": "nope"}, self.store)
        with self.assertRaises(KeyError):                         # 题不存在 ⇒ 404
            on_request("file", {"qid": "ghost", "kind": "stem"}, self.store)
        with self.assertRaises(ValueError):                       # 缺 qid
            on_request("file", {"kind": "stem"}, self.store)
        with self.assertRaises(ValueError):                       # 备注超长（不静默截断）
            on_request("file", {"qid": "q-test-1", "kind": "stem", "note": "x" * (MAX_NOTE + 1)},
                       self.store)
        with self.assertRaises(ValueError):                       # note 类型
            on_request("file", {"qid": "q-test-1", "kind": "stem", "note": 123}, self.store)
        self.assertEqual(on_request("list", {}, self.store)["n"], 0, "被拒的不该落库")

    def test_03_list_bounds(self):
        for i in range(3):
            on_request("file", {"qid": "q-test-1", "kind": "ocr", "note": f"n{i}"}, self.store)
        got = on_request("list", {"limit": 2}, self.store)
        self.assertEqual(got["n"], 2, "limit 生效")
        self.assertEqual(got["kinds"], KINDS, "白名单随响应回给前端（两处同一套键）")
        with self.assertRaises(ValueError):
            on_request("list", {"status": "whatever"}, self.store)
        with self.assertRaises(ValueError):
            on_request("list", {"limit": "abc"}, self.store)
        self.assertEqual(on_request("list", {"limit": 999}, self.store)["n"], 3, "limit 上限被夹住")
        with self.assertRaises(KeyError):
            on_request("nope", {}, self.store)

    def test_04_user_key_cannot_be_spoofed(self):
        """`_user` 必须在 bridge 合并入参**之后**写入 —— 否则客户端自带同名值就能冒充别人。"""
        src = (REPO / "bridge" / "api.py").read_text(encoding="utf-8")
        merge = src.index("payload.update({k: (v[-1] if isinstance(v, list) and v else v)")
        assign = src.index('payload["_user"] = b.user_of(self)')
        self.assertLess(merge, assign, "`_user` 必须在入参合并之后才写")

    def test_05_schema_version_includes_reports(self):
        self.assertGreaterEqual(SCHEMA_VERSION, 7)
        tabs = {r[0] for r in self.store.conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertIn("question_reports", tabs)


if __name__ == "__main__":
    unittest.main()
