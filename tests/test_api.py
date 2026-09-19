"""tests/test_api.py —— [T3] bridge 端点契约（本地起服，无外网依赖）。

对齐 ARCHITECTURE §11.5 / §13.2 / §13.3 与 §12.4 的验收项：
  ① 无 cookie → `/api/*` 401      ② 静态面匿名可读、`web/tests/**` 与 dotfile → 403
  ③ `/setup` 错误 token 连续失败 → 429；正确 token → 302 + Set-Cookie
  ④ 带 cookie → 200              ⑤ judge 落库（attempts）⑥ 未知 qid → 404
  ⑦ blob 版本冲突 → 409 + 最新 blob ⑧ 限速（api_per_minute）→ 429
  ⑨ 派生式会话：重启服务 cookie 仍有效；换 token 后旧 cookie 失效
  ⑩ 服务间凭据（ADR-015 决策 3 / 规格 §3.8 用例 1–16）：Bearer → 200 且**不发 cookie**、
     域分离双向 401、两个桶互不挤爆、未验证 Bearer 落回 IP 桶、桶键不含凭据原文、
     `/setup` 锁定期内正确 token 也 429、轮换 token ⇒ **两条凭据同时失效**
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

from bridge.api import (Bridge, agent_value, load_config, make_server,  # noqa: E402
                        session_value)
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
         cookie: str | None = None, bearer: str | None = None,
         timeout: float = 5.0, follow: bool = False) -> tuple[int, dict, dict]:
    """`cookie` / `bearer` 是本测试的**两个独立凭据通道**；都不传 = 匿名。

    注意：这里用裸 `urlopen`（**无 cookie jar**）—— 规格 §3.8 用例 5 要求
    "Bearer 值当 cookie 用 → 401"必须在无 jar 的前提下测，否则真 cookie 会把用例救活。
    """
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if cookie:
        req.add_header("Cookie", cookie)
    if bearer is not None:
        req.add_header("Authorization", f"Bearer {bearer}")
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


class ServerCase(unittest.TestCase):
    """起一个真服务的最小基类 —— **只提供夹具，不含用例**。

    为什么要拆出来：`RateLimitCase` 把额度压到 3/分钟，若它还继承整套契约用例，
    那些用例会因为**限速**（而非被测性质）变成 429 而假红。夹具与用例集分开后，
    "限速档"就只跑限速用例。
    """

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

    @property
    def bearer(self) -> str:
        """服务间凭据 —— 用**与服务器同一个函数**派生（规格 §3.8 用例 14 的保真要求）。"""
        return agent_value(self.token)


class APITestCase(ServerCase):
    """默认额度下的完整契约用例集（继承 ServerCase 的夹具）。"""

    # ---- ① 鉴权门
    def test_01_api_requires_cookie(self) -> None:
        status, body, _ = _req(self.url("/api/state"))
        self.assertEqual(status, 401, body)

    def test_01b_cookie_slides_on_use(self) -> None:
        """滑动续期：已鉴权请求要带回新的 Set-Cookie（永久鉴权的关键）。"""
        status, _, headers = _req(self.url("/api/state"), cookie=self.cookie)
        self.assertEqual(status, 200)
        cookie = headers.get("Set-Cookie", "")
        self.assertIn(self.cfg.cookie_name, cookie, "已鉴权请求应顺带续期 cookie")
        self.assertIn("Max-Age=", cookie)

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
    def test_10b_daily_questions_payload(self) -> None:
        """题库端点：替代 fork 的 data-questions.js（BOUNDARY §0 的替换裁定）。"""
        status, body, _ = _req(self.url("/api/daily"), cookie=self.cookie)
        self.assertEqual(status, 200, body)
        qs = body.get("questions")
        self.assertIsInstance(qs, list)
        self.assertGreaterEqual(len(qs), 1, "题库非空（test_07 已灌 2 题）")
        for f in ("id", "kid", "type", "stem", "options", "answer", "difficulty"):
            self.assertIn(f, qs[0])
        # 同一天同一批：两次请求顺序与内容一致（确定性）
        _, body2, _ = _req(self.url("/api/daily"), cookie=self.cookie)
        self.assertEqual([q["id"] for q in qs], [q["id"] for q in body2["questions"]])
        # 未登录拿不到题库
        status_noauth, _, _ = _req(self.url("/api/daily"))
        self.assertEqual(status_noauth, 401)

    def test_11_module_rpc_phase_gating(self) -> None:
        status, body, _ = _req(self.url("/m/review/sync"), method="POST", body={},
                               cookie=self.cookie)
        self.assertEqual(status, 404, "phase 2a 的模块在 Phase 1 不该被装载")

    # ---- ⑩ 服务间凭据（ADR-015 决策 3；规格 §3.8 用例 1–16）
    def test_14_bearer_ok_and_no_cookie_back(self) -> None:
        """规格 §3.8 用例 3 + **11**：正确 Bearer → 200，且响应**不含 Set-Cookie**。

        用例 11 是**唯一能测出 B2 的用例**：滑动续期若无条件置位，持 agent 凭据者
        一次成功请求就能读到浏览器会话值（§3.2「互不可替代」单向失效）。
        """
        status, body, headers = _req(self.url("/api/state"), bearer=self.bearer)
        self.assertEqual(status, 200, body)
        self.assertNotIn("Set-Cookie", headers, "agent 路径不得收到浏览器会话 cookie")
        self.assertEqual(self.bridge.agent_value, agent_value(self.token),
                         "用例 14 保真：两边派生必须逐字相等")

    def test_15_wrong_bearer_is_401(self) -> None:
        """规格 §3.8 用例 2（另覆盖"形状不符"的四种头）。"""
        for bad in ("", "x", self.bearer[:-1], self.bearer.upper()):
            with self.subTest(bad=bad[:8]):
                status, _, _ = _req(self.url("/api/state"), bearer=bad)
                self.assertEqual(status, 401)

    def test_16_domain_separation_both_directions(self) -> None:
        """规格 §3.8 用例 4 + 5：cookie 值当 Bearer 用 → 401；Bearer 值当 cookie 用 → 401。"""
        status, _, _ = _req(self.url("/api/state"), bearer=session_value(self.token))
        self.assertEqual(status, 401, "浏览器会话值不得能当服务间凭据")
        status, _, _ = _req(self.url("/api/state"),
                            cookie=f"{self.cfg.cookie_name}={self.bearer}")
        self.assertEqual(status, 401, "服务间凭据不得能当 cookie（客户端无 jar）")

    def test_17_setup_lockout_blocks_correct_token(self) -> None:
        """规格 §3.8 用例 15（**专测 B4 那条静默失效**）。

        失败计数与锁定检查若用了不同的键，锁**永不命中**且无报错 —— 这里断言
        "锁定期内连正确 token 也 429"；若实现改成了 `ip:<ip>` 而写入侧仍是裸 IP，
        本用例会看到 302/401。
        """
        for _ in range(self.setup_max_failures):
            _req(self.url("/setup?t=wrong"))
        status, _, _ = _req(self.url(f"/setup?t={self.token}"))
        self.assertEqual(status, 429, "锁定期内正确 token 也必须 429（否则两侧键不对称）")


class RateLimitCase(ServerCase):
    # ⚠️ 继承 ServerCase 而非 APITestCase：本档把额度压到 3/分钟，
    # 跑整套契约用例会让"4 次错凭据都该 401"因限速变 429（假红）。
    api_per_minute = 3

    def test_12_api_rate_limit(self) -> None:
        codes = []
        for _ in range(self.api_per_minute + 1):
            status, _, _ = _req(self.url("/api/state"), cookie=self.cookie)
            codes.append(status)
        self.assertEqual(codes[-1], 429, f"超出 api_per_minute 应 429，实际 {codes}")
        self.assertEqual(codes[0], 200)

    def test_18_buckets_are_independent(self) -> None:
        """规格 §3.8 用例 6 + 7：浏览器桶与 agent 桶**互不挤爆**（同 IP 下也一样）。

        这是分桶维度必须换的直接原因：部署态 `client_address` 恒为 `127.0.0.1`
        （Caddy 反代在后），按 IP 分桶 = 全站共享一个桶。
        """
        for _ in range(self.api_per_minute):
            self.assertEqual(_req(self.url("/api/state"), cookie=self.cookie)[0], 200)
        self.assertEqual(_req(self.url("/api/state"), cookie=self.cookie)[0], 429,
                         "浏览器桶应已打满")
        self.assertEqual(_req(self.url("/api/state"), bearer=self.bearer)[0], 200,
                         "浏览器桶满不得影响 agent 桶")
        for _ in range(self.api_per_minute - 1):
            self.assertEqual(_req(self.url("/api/state"), bearer=self.bearer)[0], 200)
        self.assertEqual(_req(self.url("/api/state"), bearer=self.bearer)[0], 429)

    def test_19_unverified_bearer_does_not_buy_new_buckets(self) -> None:
        """规格 §3.8 用例 12（**测 B1**）：未验证的 Bearer 随便换值 ⇒ 桶数**不增长**。"""
        for i in range(self.api_per_minute + 2):
            status, _, _ = _req(self.url("/api/state"), bearer=f"bogus-{i}")
            self.assertIn(status, (401, 429), "未鉴权请求不该拿到数据")
        keys = list(self.bridge.limiter._api)
        self.assertEqual(keys, ["ip:127.0.0.1"], f"未鉴权者换头不得换桶，实际 {keys}")

    def test_20_bucket_keys_carry_no_credential(self) -> None:
        """规格 §3.8 用例 10：桶键里**不含凭据原文**（限速表会被 dump/日志化）。"""
        self.assertEqual(_req(self.url("/api/state"), bearer=self.bearer)[0], 200)
        keys = list(self.bridge.limiter._api)
        self.assertEqual(len(keys), 1, f"一次 agent 请求应只建一个桶：{keys}")
        self.assertTrue(keys[0].startswith("agent:"), keys)
        for secret in (self.token, self.bearer, session_value(self.token)):
            self.assertNotIn(secret, keys[0])


class RotatedTokenCase(APITestCase):
    """规格 §3.8 用例 8 + 13：轮换 token ⇒ **两条凭据同时失效**（派生红利，无独立吊销）。"""

    token = TOKEN + "-rotated"

    def test_21_rotation_kills_both_credentials(self) -> None:
        old_cookie = f"{self.cfg.cookie_name}={session_value(TOKEN)}"
        self.assertEqual(_req(self.url("/api/state"), bearer=agent_value(TOKEN))[0], 401,
                         "旧服务间凭据必须失效")
        self.assertEqual(_req(self.url("/api/state"), cookie=old_cookie)[0], 401,
                         "旧 cookie 必须同时失效（用例 13）")
        self.assertEqual(_req(self.url("/api/state"), bearer=self.bearer)[0], 200)
        self.assertEqual(_req(self.url("/api/state"), cookie=self.cookie)[0], 200)


class CookieDerivationCase(unittest.TestCase):
    def test_13_cookie_survives_restart_but_dies_on_rotation(self) -> None:
        old = session_value(TOKEN)
        self.assertEqual(old, session_value(TOKEN), "同 token 必须派生出同值（重启不掉登录）")
        self.assertNotEqual(old, session_value(TOKEN + "x"), "换 token 必须换派生值（轮换即失效）")

    def test_22_domain_separation_is_structural(self) -> None:
        """两域**结构上**不可能相等（msg 不同）—— 域分离不靠"约定"，靠派生式本身。"""
        self.assertNotEqual(session_value(TOKEN), agent_value(TOKEN), "两条凭据必须不同值")
        self.assertNotEqual(agent_value(TOKEN), agent_value(TOKEN + "x"), "轮换 ⇒ 服务间凭据也变")
        self.assertEqual(agent_value(TOKEN), agent_value(TOKEN), "同 token 同域必须稳定（可离线重算）")


if __name__ == "__main__":
    unittest.main(verbosity=2)
