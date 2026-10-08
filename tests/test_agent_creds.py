"""tests/test_agent_creds.py —— 每人一把 agent 凭据（多用户隔离的最后一块）。

锁住四件事：
  1. `agent_creds` 表随 `schema_version = 6` 建起来；
  2. 登记 / 查回 / **重登即轮换**（旧的原立即失效）/ 未知凭据 ⇒ None；
  3. `Bridge.identity()` 认这把凭据（⇒ `agent`），且 `Bridge.user_of()` 解出**主人**；
     旧的**实例级**凭据仍归 `owner`（不能把原有部署打断）；
  4. 限速桶键**按凭据**分（每人一个桶，不再所有人共用一个）。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from bridge.api import Bridge  # noqa: E402
from core.store import SCHEMA_VERSION, Store  # noqa: E402


class _Handler:
    """够用的假 handler：`identity()` 只读 headers 与 client_address。"""

    def __init__(self, *, bearer: str | None = None, remote_user: str | None = None,
                 ip: str = "127.0.0.1") -> None:
        self.headers: dict[str, str] = {}
        if bearer:
            self.headers["Authorization"] = f"Bearer {bearer}"
        if remote_user:
            self.headers["Remote-User"] = remote_user
        self.client_address = (ip, 0)


def _bridge(store: Store) -> Bridge:
    b = Bridge.__new__(Bridge)          # 只装 identity/user_of/bucket_key 需要的那几个属性
    b.store = store
    b.cfg = SimpleNamespace(cookie_name="md_session", owner_user="zhu")
    b.cookie_value = "session-value"
    b.agent_value = "legacy-instance-cred"
    return b


class AgentCredCase(unittest.TestCase):
    def test_01_table_created_with_schema_6(self):
        with TemporaryDirectory() as td:
            st = Store(td)
            self.assertGreaterEqual(SCHEMA_VERSION, 6)
            tabs = {r[0] for r in st.conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertIn("agent_creds", tabs)
            st.close()

    def test_02_set_lookup_and_rotate(self):
        with TemporaryDirectory() as td:
            st = Store(td)
            st.set_agent_cred(user="alice", raw="CRED-1")
            self.assertEqual(st.user_of_agent_cred("CRED-1"), "alice")
            st.set_agent_cred(user="alice", raw="CRED-2")            # 重登 ⇒ 轮换
            self.assertIsNone(st.user_of_agent_cred("CRED-1"), "旧凭据必须失效")
            self.assertEqual(st.user_of_agent_cred("CRED-2"), "alice")
            self.assertIsNone(st.user_of_agent_cred("NOPE"))
            self.assertIsNone(st.user_of_agent_cred(""))
            st.close()

    def test_03_identity_and_user_mapping(self):
        with TemporaryDirectory() as td:
            st = Store(td)
            st.set_agent_cred(user="alice", raw="CRED-ALICE")
            b = _bridge(st)
            self.assertEqual(b.identity(_Handler(bearer="CRED-ALICE")), "agent")
            self.assertEqual(b.user_of(_Handler(bearer="CRED-ALICE")), "alice")
            # 旧实例级凭据：仍然有效，且仍归 owner（不能打断既有部署）
            self.assertEqual(b.identity(_Handler(bearer="legacy-instance-cred")), "agent")
            self.assertEqual(b.user_of(_Handler(bearer="legacy-instance-cred")), "owner")
            # 管理员映射：Authelia 用户 zhu ⇒ owner
            self.assertEqual(b.user_of(_Handler(remote_user="zhu")), "owner")
            self.assertEqual(b.user_of(_Handler(remote_user="alice")), "alice")
            # 伪造头 + 非回环来源 ⇒ 不认（回落到 owner）
            self.assertEqual(b.user_of(_Handler(remote_user="alice", ip="1.2.3.4")), "owner")
            # 未鉴权
            self.assertEqual(b.identity(_Handler()), "anon")
            st.close()

    def test_04_rate_bucket_is_per_credential(self):
        with TemporaryDirectory() as td:
            st = Store(td)
            st.set_agent_cred(user="alice", raw="CRED-ALICE")
            st.set_agent_cred(user="bob", raw="CRED-BOB")
            b = _bridge(st)
            k_alice = b.bucket_key(_Handler(bearer="CRED-ALICE"))
            k_bob = b.bucket_key(_Handler(bearer="CRED-BOB"))
            k_legacy = b.bucket_key(_Handler(bearer="legacy-instance-cred"))
            self.assertEqual(len({k_alice, k_bob, k_legacy}), 3, "每人一个桶（不许共用）")
            self.assertTrue(all(k.startswith("agent:") and len(k) == len("agent:") + 16
                                for k in (k_alice, k_bob, k_legacy)), "桶键只含哈希前缀")
            st.close()


if __name__ == "__main__":
    unittest.main()
