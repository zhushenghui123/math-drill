"""tests/test_api.py —— [T3] bridge 端点契约（本地起服，无外网依赖）。

对齐 ARCHITECTURE §11.5 / §13.2 / §13.3 与 §12.4 的验收项：
  ① 无 cookie → `/api/*` 401      ② 静态面匿名可读、`web/tests/**` 与 dotfile → 403
  ③ `/setup` 错误 token 连续失败 → 429；正确 token → 302 + Set-Cookie
  ④ 带 cookie → 200              ⑤ judge 落库（attempts）⑥ 未知 qid → 404
  ⑦ blob 版本冲突 → 409 + 最新 blob ⑧ 限速（api_per_minute）→ 429
  ⑨ 派生式会话：重启服务 cookie 仍有效；换 token 后旧 cookie 失效
"""

from __future__ import annotations

import dataclasses
import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from tempfile import TemporaryDirectory

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from bridge.api import Bridge, load_config, make_server, session_value  # noqa: E402
from core.registry import Registry  # noqa: E402
from core.store import Store  # noqa: E402

TOKEN = "test-token-not-a-secret-1234567890"
QUESTION = {"id": "linalg.det.3x3.a", "answer_type": "rational", "answer": "-3",
            "kid": "c1n1", "difficulty": 2, "type": "blank", "source": "generated"}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """不自动跟随重定向（我们要断言 302 本身，以及读它带的 Set-Cookie）。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _req(url: str, *, method: str = "GET", body: dict | None = None,
         cookie: str | None = None, timeout: float = 5.0, follow: bool = False) -> tuple[int, dict, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        opener = urllib.request.urlopen if follow else _OPENER.open
        with opener(req, timeout=timeout) as r:
            payload = r.read().decode("utf-8") or "{}"
            try:
                parsed = json.loads(payload)
            except json.JSONDecodeError:
                parsed = {"_raw": payload[:80]}
            return r.status, parsed, dict(r.headers)
    except urllib.error.HTTPError as e:
        payload = e.read().decode("utf-8") or "{}"
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError:
            parsed = {"_raw": payload[:80]}
        return e.code, parsed, dict(e.headers)


class APITestCase(unittest.TestCase):
    token = TOKEN
    api_per_minute = 60
    setup_max_failures = 3

    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.data_dir = Path(self._tmp.name)

        base = load_config(REPO)
        self.cfg = dataclasses.replace(base, data_dir=str(self.data_dir), port=0,
                                      api_per_minute=self.api_per_minute,
                                      setup_max_failures=self.setup_max_failures)
        self.store = Store(self.data_dir)
        self.addCleanup(self.store.close)
        self.store.load_questions([QUESTION])

        self.registry = Registry(REPO, phase="1")
        self.registry.load_all()
        self.bridge = Bridge(self.cfg, self.token, self.store, self.registry)
        self.server = make_server(self.cfg, self.bridge)
        self.port = self.server.server_port
        t = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05},
                             daemon=True)
        t.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    # ---- 工具
    def url(self, path: str) -> str:
        return f"http://127.0.0.1:{self.port}{path}"

    @property
    def cookie(self) -> str:
        return f"{self.cfg.cookie_name}={session_value(self.token)}"

    # ---- ① 鉴权门
    def test_01_api_requires_cookie(self) -> None:
        status, body, _ = _req(self.url("/api/state"))
        self.assertEqual(status, 401, body)

    def test_02_with_cookie_ok(self) -> None:
        status, body, _ = _req(self.url("/api/state"), cookie=self.cookie)
        self.assertEqual(status, 200)
        self.assertIn("server_version", body)

    # ---- ② 静态面与 403 规则
    def test_03_static_anonymous_and_403_rules(self) -> None:
        status, _, _ = _req(self.url("/"))
        self.assertEqual(status, 200, "静态入口应匿名可读")
        for path in ("/tests/run-all.js", "/.gitignore", "/js/../.gitignore"):
            with self.subTest(path=path):
                status, _, _ = _req(self.url(path))
                self.assertEqual(status, 403, f"{path} 应 403")
        status, _, _ = _req(self.url("/no-such-file.js"))
        self.assertEqual(status, 404)

    # ---- ③ /setup
    def test_04_setup_wrong_token_then_rate_limited(self) -> None:
        for i in range(self.setup_max_failures):
            with self.subTest(attempt=i + 1):
                status, body, _ = _req(self.url("/setup?t=wrong"))
                self.assertEqual(status, 401)
                self.assertNotIn("token", json.dumps(body))
        status, body, _ = _req(self.url("/setup?t=wrong"))
        self.assertEqual(status, 429, "第 4 次应被限速（§12.4 ③）")

    def test_05_setup_correct_sets_cookie(self) -> None:
        status, _, headers = _req(self.url(f"/setup?t={self.token}"))
        self.assertEqual(status, 302)
        cookie = headers.get("Set-Cookie", "")
        self.assertIn(self.cfg.cookie_name, cookie)
        for attr in ("HttpOnly", "Secure", "SameSite=Strict", "Max-Age="):
            self.assertIn(attr, cookie)

    # ---- ④⑤⑥ judge
    def test_06_judge_and_attempt_recorded(self) -> None:
        status, body, _ = _req(self.url("/api/judge"), method="POST",
                               body={"qid": QUESTION["id"], "raw_answer": "  -3  ",
                                     "user_ms": 1200, "device": "test"},
                               cookie=self.cookie)
        self.assertEqual(status, 200, body)
        self.assertEqual(body["verdict"], "server_true")
        self.assertIs(body["correct"], True)
        rows = self.store.list_attempts()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["verdict"], "server_true")
        self.assertEqual(rows[0]["correct"], 1)
        self.assertEqual(rows[0]["device"], "test")

    def test_07_judge_attack_case_is_false(self) -> None:
        self.store.load_questions([{**QUESTION, "id": "attack.1", "answer": "1+sqrt(2)"}])
        status, body, _ = _req(self.url("/api/judge"), method="POST",
                               body={"qid": "attack.1", "raw_answer": "1"}, cookie=self.cookie)
        self.assertEqual(status, 200)
        self.assertEqual(body["verdict"], "server_false")

    def test_08_judge_unknown_qid(self) -> None:
        status, body, _ = _req(self.url("/api/judge"), method="POST",
                               body={"qid": "nope", "raw_answer": "1"}, cookie=self.cookie)
        self.assertEqual(status, 404)
        self.assertEqual(body["error"], "unknown_qid")

    def test_09_judge_malformed(self) -> None:
        status, body, _ = _req(self.url("/api/judge"), method="POST",
                               body={"qid": QUESTION["id"]}, cookie=self.cookie)
        self.assertEqual(status, 400)
        self.assertEqual(body["error"], "malformed_request")

    # ---- ⑦ 版本冲突
    def test_10_blob_conflict_returns_latest(self) -> None:
        status, body, _ = _req(self.url("/api/state"), method="PUT",
                               body={"base_version": 0, "data": {"daily": {"updated_at": 5}}},
                               cookie=self.cookie)
        self.assertEqual(status, 200)
        self.assertEqual(body["server_version"], 1)
        status, body, _ = _req(self.url("/api/state"), method="PUT",
                               body={"base_version": 0, "data": {"daily": {"updated_at": 9}}},
                               cookie=self.cookie)
        self.assertEqual(status, 409)
        self.assertEqual(body["latest"]["server_version"], 1)

    # ---- ⑩ 模块路由（phase 门）
    def test_11_module_rpc_phase_gating(self) -> None:
        status, body, _ = _req(self.url("/m/review/sync"), method="POST", body={},
                               cookie=self.cookie)
        self.assertEqual(status, 404, "phase 2a 的模块在 Phase 1 不该被装载")


class RateLimitCase(APITestCase):
    api_per_minute = 3

    def test_12_api_rate_limit(self) -> None:
        codes = []
        for _ in range(self.api_per_minute + 1):
            status, _, _ = _req(self.url("/api/state"), cookie=self.cookie)
            codes.append(status)
        self.assertEqual(codes[-1], 429, f"超出 api_per_minute 应 429，实际 {codes}")
        self.assertEqual(codes[0], 200)


class CookieDerivationCase(unittest.TestCase):
    def test_13_cookie_survives_restart_but_dies_on_rotation(self) -> None:
        old = session_value(TOKEN)
        self.assertEqual(old, session_value(TOKEN), "同 token 必须派生出同值（重启不掉登录）")
        self.assertNotEqual(old, session_value(TOKEN + "x"), "换 token 必须换派生值（轮换即失效）")


if __name__ == "__main__":
    unittest.main(verbosity=2)
