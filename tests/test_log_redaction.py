"""tests/test_log_redaction.py —— 访问日志**不得出现 query 串**（2026-10-07 既存缺陷的回归）。

缺陷原文：`/setup?t=<主 token>` 会把**主 token 明文**写进 `/var/log/math-drill.log`
（生产实测 10 处、文件 0644），与 ARCHITECTURE §13.3⑤「日志不记 token 值」的承诺相反。
修法在 `bridge/api.py` 的 `Handler.log_message`：写之前一律抹掉 query。

这里不启真服务（不依赖环境变量、不碰网络），直接调 `log_message` 并捕获 stderr ——
它正是 systemd (`StandardError=append:`) 收走的那条流，所以断在这里等价于断在日志文件里。
"""

from __future__ import annotations

import io
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from bridge.api import Handler  # noqa: E402


class _Probe(Handler):
    """只借 `log_message` 这一个方法：不走 BaseHTTPRequestHandler 的初始化（不需要真连接）。"""

    def __init__(self) -> None:      # noqa: D107
        pass

    def address_string(self) -> str:
        return "127.0.0.1"


class LogRedactionCase(unittest.TestCase):
    def _log(self, fmt: str, *args) -> str:
        buf = io.StringIO()
        old = sys.stderr
        sys.stderr = buf
        try:
            _Probe().log_message(fmt, *args)
        finally:
            sys.stderr = old
        return buf.getvalue()

    def test_setup_token_never_reaches_log(self):
        out = self._log('"%s" %s -', "GET /setup?t=SECRETTOKEN123 HTTP/1.1", 302)
        self.assertNotIn("SECRETTOKEN123", out, out)
        self.assertIn("/setup", out)

    def test_any_query_is_stripped(self):
        """不是只对 /setup 特判：任何端点的 query 都不进日志（将来带敏感参数的端点自动受保护）。"""
        out = self._log('"%s" %s -', "GET /m/qbank/list?subject=linear&wrong=true HTTP/1.1", 200)
        self.assertNotIn("subject=linear", out, out)
        self.assertNotIn("wrong=true", out, out)
        self.assertIn("/m/qbank/list", out)

    def test_path_and_status_kept(self):
        """治的是泄漏，不是把日志废掉：方法与状态码必须留着（运维要靠它）。"""
        out = self._log('"%s" %s -', "GET /api/daily HTTP/1.1", 401)
        self.assertIn("GET /api/daily", out)
        self.assertIn("401", out)


if __name__ == "__main__":
    unittest.main()
