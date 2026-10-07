"""bridge/api.py —— HTTP **唯一持有者** + 进程入口（`python3 -m bridge.api`）。

规格：ARCHITECTURE §11.5（路由权威）/ §12（部署）/ §13（配置与凭据）。

规则（与文档一一对应）：
  · 自有端点恰好五个：`/api/state`、`/api/judge`、`/api/daily`、**`/api/kp`**、**`/api/attempts`**（另有引导端点 `/setup`）——
    ADR-015 决策 3 说"加鉴权路径不等于加端点"；**ADR-016 把只读端点从三个扩到五个**。
    改了端点集合 ⇒ 要同批改的**活载体名单以 ADR-016 代价 1 为准**（实测 6 处：本行只是其中之一），
    此处不再自列名单（旧版本自列的"三处"与 ADR 的"四处"、实测的"六处"三份互不相同，是 2026-10-07 复核 F2）。
  · `/api/*` 与 `/m/*` 一律过 **凭据门 + 限速**；凭据 = 浏览器会话 cookie **或** 服务间 Bearer，
    二者**互不可替代**；`/setup` 是**唯一不过门**的例外（它就是换凭证的入口）
  · 模块路由 `/m/<模块>/<rpc>` 的**入参** = JSON body ⊕ 查询串（同名查询串优先，ADR-017 决策 6）；
    当前已落地的模块路由只有 `qbank`（题库浏览，ADR-017）—— 它**不是**自有端点，端点集合不受影响
  · 静态面（`/`、`/js/*`、`/assets/*`）**匿名可读**；`web/tests/**` 与任何 dotfile → **403**
  · 次序：先路径合法性（越权 → 403），后鉴权（`/api/*`、`/m/*` **无任何凭据**（cookie 或 Bearer）→ 401）
  · token 从 `MATH_DRILL_TOKEN_FILE` 指向的文件读；**缺失或为空 → 拒绝启动**（fail-closed）
  · 会话 cookie = 派生值 `HMAC-SHA256(key=token, msg="md-session-v1")`（零存储；轮换 token 即失效）
  · 服务间凭据 = 派生值 `HMAC-SHA256(key=token, msg="md-agent-v1")`（**域分离**：与 cookie 同源不同域，
    互不可推导 / 互不可替代；ADR-015 决策 3 —— 轮换 token ⇒ 两条一起失效）
  · 限速桶键按**身份**（§13.1 注①）：浏览器与未鉴权 → `ip:<来源>`；服务间 → `agent:<sha256[:16]>`
    （桶表内**不存凭据原文**）；`/setup` 仍按来源 IP（鉴权前的引导入口）
  · 绑定与端口只读 `config/server.toml`，**没有** CLI / env 覆盖
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import sys
import time
import tomllib
from datetime import date
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from contracts.answer_types import ErrorCode
from core.judge import JudgeError, judge
from core.registry import Registry
from core.store import ConflictError, Store

REPO = Path(__file__).resolve().parent.parent
SESSION_MSG = b"md-session-v1"
AGENT_MSG = b"md-agent-v1"          # 服务间凭据的域分离常量（ADR-015 决策 3；≠ SESSION_MSG）


# ---------------------------------------------------------------- 配置与凭据

@dataclass(frozen=True)
class Config:
    bind_host: str
    port: int
    static_root: str
    data_dir: str
    cookie_name: str
    cookie_ttl_days: int
    token_file_env: str
    api_per_minute: int
    setup_max_failures: int
    setup_window_seconds: int


def load_config(repo: Path | str = REPO) -> Config:
    with open(Path(repo) / "config" / "server.toml", "rb") as f:
        c = tomllib.load(f)
    s, a, r = c["server"], c["auth"], c["ratelimit"]
    return Config(
        bind_host=s["bind_host"], port=int(s["port"]), static_root=s["static_root"],
        data_dir=s["data_dir"], cookie_name=a["cookie_name"],
        cookie_ttl_days=int(a["cookie_ttl_days"]), token_file_env=a["token_file_env"],
        api_per_minute=int(r["api_per_minute"]),
        setup_max_failures=int(r["setup_max_failures"]),
        setup_window_seconds=int(r["setup_window_seconds"]),
    )


def load_token(cfg: Config, env: dict | None = None) -> str:
    """读 token 文件；**缺失或为空 → 拒绝启动**（§13.1，不设默认 token）。"""
    env = os.environ if env is None else env
    path = env.get(cfg.token_file_env, "")
    if not path:
        raise RuntimeError(f"拒绝启动：环境变量 {cfg.token_file_env} 未设置（见 ARCHITECTURE §13.1）")
    p = Path(path)
    if not p.exists():
        raise RuntimeError(f"拒绝启动：token 文件不存在 {p}")
    token = p.read_text(encoding="utf-8").strip()
    if not token:
        raise RuntimeError(f"拒绝启动：token 文件为空 {p}")
    return token


def session_value(token: str) -> str:
    """派生式会话值（§13.3）：零存储、可重算、轮换 token 自动失效。"""
    return hmac.new(token.encode("utf-8"), SESSION_MSG, hashlib.sha256).hexdigest()


def agent_value(token: str) -> str:
    """服务间凭据（ADR-015 决策 3）：与浏览器会话**同源不同域**。

    域分离：msg 与 `SESSION_MSG` 不同 ⇒ 两条凭据互不可推导、互不可替代。
    派生红利：轮换 token ⇒ 两条**同时自动失效**，无需额外吊销机制。
    已知取舍：派生式**放弃独立吊销** —— 泄露响应只能是整体轮换（N=1 接受）。
    """
    return hmac.new(token.encode("utf-8"), AGENT_MSG, hashlib.sha256).hexdigest()


# ---------------------------------------------------------------- 限速

class RateLimiter:
    """固定窗口限速（§13.1 尾注的语义）。

    · `/api/*` 与 `/m/*`：**计全部请求**（不论成败）
    · `/setup`：**只计失败**（成功即清零），窗口内超限 → 429
    """

    def __init__(self, api_per_minute: int, setup_max_failures: int, window: int) -> None:
        self.api_limit = api_per_minute
        self.setup_limit = setup_max_failures
        self.window = window
        self._api: dict[str, tuple[float, int]] = {}
        self._setup: dict[str, tuple[float, int]] = {}

    def hit_api(self, bucket: str, now: float | None = None) -> bool:
        """返回 True 表示放行；False = 429。`bucket` 由 `Bridge.bucket_key` 单点构造。"""
        now = time.time() if now is None else now
        start, count = self._api.get(bucket, (now, 0))
        if now - start >= 60:
            start, count = now, 0
        count += 1
        self._api[bucket] = (start, count)
        return count <= self.api_limit

    def blocked_setup(self, ip: str, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        start, fails = self._setup.get(ip, (now, 0))
        if now - start >= self.window:
            self._setup[ip] = (now, 0)
            return False
        return fails >= self.setup_limit

    def record_setup_failure(self, ip: str, now: float | None = None) -> None:
        now = time.time() if now is None else now
        start, fails = self._setup.get(ip, (now, 0))
        if now - start >= self.window:
            start, fails = now, 0
        self._setup[ip] = (start, fails + 1)

    def clear_setup(self, ip: str) -> None:
        self._setup.pop(ip, None)


# ---------------------------------------------------------------- 业务面

class Bridge:
    """把 store / registry / 配置 绑在一起（handler 用它，不自己碰全局）。"""

    def __init__(self, cfg: Config, token: str, store: Store, registry: Registry) -> None:
        self.cfg = cfg
        self.token = token
        self.cookie_value = session_value(token)
        self.agent_value = agent_value(token)
        self.store = store
        self.registry = registry
        self.limiter = RateLimiter(cfg.api_per_minute, cfg.setup_max_failures,
                                   cfg.setup_window_seconds)
        self.static_root = (REPO / cfg.static_root).resolve() if not Path(cfg.static_root).is_absolute() \
            else Path(cfg.static_root).resolve()

    # ---- 工具
    def cookie_header(self) -> str:
        """下发/续期会话 cookie 的唯一出处（/setup 与「滑动续期」共用，避免两处写法漂移）。"""
        c = self.cfg
        return (f"{c.cookie_name}={self.cookie_value}; HttpOnly; Secure; "
                f"SameSite=Strict; Max-Age={c.cookie_ttl_days * 86400}; Path=/")

    def cookies(self, handler: BaseHTTPRequestHandler) -> dict[str, str]:
        raw = handler.headers.get("Cookie", "")
        out = {}
        for part in raw.split(";"):
            if "=" in part:
                k, v = part.split("=", 1)
                out[k.strip()] = v.strip()
        return out

    def bearer_of(self, handler: BaseHTTPRequestHandler) -> str:
        """取 `Authorization: Bearer <值>` 的值；无此头或形状不符 ⇒ `""`（绝不抛）。"""
        raw = handler.headers.get("Authorization", "")
        prefix = "bearer "
        if raw[:len(prefix)].lower() == prefix:
            return raw[len(prefix):].strip()
        return ""

    def identity(self, handler: BaseHTTPRequestHandler) -> str:
        """每请求的**身份判定单点**（§3.4）：返回 `browser` / `agent` / `anon`。

        为什么必须单点且必须先于限速：桶键若采信**未验证**的头，未鉴权者每换一个
        Authorization 值就换一个新桶 ⇒ 限速形同虚设（评审 B1）。故只有**已验证**的
        凭据才分档，其余一律 `anon`（回落 IP 桶）。
        两条路径都用 `hmac.compare_digest`（常数时间）；同时有效时判 `browser`（它确实是浏览器）。

        **边缘鉴权（ADR-021，2026-10-07）**：Caddy 前面挂了 Authelia（`forward_auth`），
        鉴权通过后它会注入 `Remote-User`（官方集成文档的标准做法）。这里把该头认成浏览器身份。
        ⚠️ **只信回环来源**：服务只绑 `127.0.0.1`（config/server.toml），能从这个地址连过来的
        本来就有本机权限；外网客户端无法伪造（它们连不到 8081，只到 Caddy）。
        带 `Authorization` 头的服务间请求在 Caddy 侧已被排除在 `forward_auth` 之外，
        所以 agent 那条路不受影响（两者互不冒充的纪律不破）。
        """
        remote_user = handler.headers.get("Remote-User")
        if remote_user and handler.client_address[0] == "127.0.0.1":
            return "browser"
        got = self.cookies(handler).get(self.cfg.cookie_name, "")
        if got and hmac.compare_digest(got, self.cookie_value):
            return "browser"
        bearer = self.bearer_of(handler)
        if bearer and hmac.compare_digest(bearer, self.agent_value):
            return "agent"
        return "anon"

    def bucket_key(self, handler: BaseHTTPRequestHandler) -> str:
        """限速桶键（§3.5）：已验证的服务间凭据用**哈希桶**（表内不存原文），其余按来源 IP。"""
        if self.identity(handler) == "agent":
            return "agent:" + hashlib.sha256(self.agent_value.encode("utf-8")).hexdigest()[:16]
        return "ip:" + handler.client_address[0]

    def authed(self, handler: BaseHTTPRequestHandler) -> bool:
        """凭据门：cookie **或** 服务间 Bearer（判定收敛在 `identity`，此处只做二值化）。"""
        return self.identity(handler) != "anon"

    def static_path(self, url_path: str) -> tuple[Path | None, int]:
        """返回 (文件路径 | None, HTTP 状态)。403 = 越权；404 = 不存在。"""
        rel = url_path.lstrip("/") or "index.html"
        rel = rel.split("?", 1)[0]
        parts = [p for p in rel.split("/") if p]
        if any(p.startswith(".") for p in parts):      # dotfile 一律 403
            return None, HTTPStatus.FORBIDDEN
        if parts and parts[0] == "tests":              # web/tests/** 一律 403
            return None, HTTPStatus.FORBIDDEN
        candidate = (self.static_root / rel).resolve()
        if not str(candidate).startswith(str(self.static_root)):
            return None, HTTPStatus.FORBIDDEN          # 目录穿越
        if not candidate.is_file():
            return None, HTTPStatus.NOT_FOUND
        return candidate, HTTPStatus.OK

    def judge_request(self, payload: dict) -> tuple[int, dict]:
        qid = payload.get("qid")
        raw = payload.get("raw_answer")
        if not isinstance(qid, str) or not isinstance(raw, str):
            return HTTPStatus.BAD_REQUEST, {"error": ErrorCode.MALFORMED_REQUEST.value,
                                            "message": "需要 qid 与 raw_answer（字符串）"}

        row = self.store.conn.execute(
            "SELECT answer_type, answer, type, kid FROM questions WHERE id=?", (qid,)
        ).fetchone()
        if row is None:
            return HTTPStatus.NOT_FOUND, {"error": ErrorCode.UNKNOWN_QID.value,
                                          "message": f"题库没有 {qid}"}
        try:
            result = judge(raw, answer_type=row["answer_type"], canonical=row["answer"],
                           q_type=row["type"])
        except JudgeError as exc:
            return HTTPStatus.BAD_REQUEST, {"error": exc.code, "message": str(exc)}

        self.store.record_attempt(qid=qid, kid=row["kid"], result=result,
                                  user_ms=payload.get("user_ms"), device=payload.get("device"))
        return HTTPStatus.OK, result

    def attempts_summary(self, *, days: int = 30, limit: int = 200) -> dict:
        """做题记录的**聚合**（ADR-016 决策 2 的只读端点数据面）。

        为什么聚合而不是原样给：agent 要的是"你在哪弱"，不是流水账；
        且原样给会把上下文塞爆。**标题/答案一律不出**——只回判定结果与题号/考点。
        时间**降到天**（`day`），不给秒级时间戳：那会成为系统里第一个
        "能还原你几点在做题"的读面（评审 Q7②）。
        """
        since = time.time() - days * 86400
        rows = [r for r in self.store.list_attempts() if float(r.get("ts") or 0) >= since]
        by_qid = {q["id"]: q for q in self.store.list_questions()}
        totals = {"n": len(rows), "correct": 0, "wrong": 0, "accuracy": None}
        kids: dict[str, dict] = {}
        diffs: dict[str, dict] = {}
        for r in rows:
            ok = bool(r.get("correct"))
            totals["correct" if ok else "wrong"] += 1
            for bucket, key in ((kids, str(r.get("kid") or "?")), (None, None)):
                if bucket is None:
                    break
                slot = bucket.setdefault(key, {"kid": key, "n": 0, "wrong": 0})
                slot["n"] += 1
                slot["wrong"] += 0 if ok else 1
            q = by_qid.get(r.get("qid")) or {}
            dk = str(q.get("difficulty", "?"))
            slot = diffs.setdefault(dk, {"difficulty": dk, "n": 0, "wrong": 0})
            slot["n"] += 1
            slot["wrong"] += 0 if ok else 1
        if totals["n"]:
            totals["accuracy"] = round(totals["correct"] / totals["n"], 4)
        recent = [{
            "day": time.strftime("%Y-%m-%d", time.localtime(float(r.get("ts") or 0))),
            "qid": r.get("qid"), "kid": r.get("kid"),
            "correct": bool(r.get("correct")), "verdict": r.get("verdict"),
            "user_ms": r.get("user_ms"),
            "type": (by_qid.get(r.get("qid")) or {}).get("type"),
            "difficulty": (by_qid.get(r.get("qid")) or {}).get("difficulty"),
        } for r in rows[-limit:]]
        for slot in list(kids.values()) + list(diffs.values()):
            slot["accuracy"] = round((slot["n"] - slot["wrong"]) / slot["n"], 4) if slot["n"] else None
        return {"schemaVersion": 1, "window": {"days": days, "since": since},
                "totals": totals,
                "byKid": sorted(kids.values(), key=lambda x: (-x["wrong"], x["kid"])),
                "byDifficulty": sorted(diffs.values(), key=lambda x: x["difficulty"]),
                "recent": recent}

    # ---- 题库（替代 fork 的 data-questions.js；BOUNDARY §0 的「替换」裁定）
    @staticmethod
    def _question_json(row, *, with_answer: bool = True) -> dict:
        """DB 行 → 前端题目对象（形状与 fork 的 QDATA 一致：options 是数组）。"""
        opts = row["options"]
        try:
            options = json.loads(opts) if opts else None
        except (TypeError, json.JSONDecodeError):
            options = None
        q = {
            "id": row["id"], "kid": row["kid"], "type": row["type"],
            "stem": row["stem"], "options": options,
            "difficulty": row["difficulty"], "source": row["source"],
        }
        if with_answer:
            q["answer"] = row["answer"]
            q["analysis"] = row["analysis"] or ""
        return q

    def daily_questions(self, limit: int = 8, *, with_answer: bool = True) -> list[dict]:
        """当日题单：**同一天同一批**（按日期确定性选择），够用且可复现。

        为什么先这么简单：Phase 1 的目标是"能稳定做题"，真正的选题器是 P2b 的 `modules/picker`。
        这里不引入复杂度，只保证「今天这 8 题今天不变」。
        """
        # ADR-019 决策 4：**未审核的语料题不进练习池**。练习池 = practice_pool()（排除 verify='unverified'），
        # 而 `list_questions()` 仍给"题库栏目"用 —— "看得见"与"能拿来练"是两条不同的门。
        rows = self.store.practice_pool()
        if not rows:
            return []
        seed = int(hashlib.sha1(date.today().isoformat().encode("utf-8")).hexdigest()[:8], 16)
        start = seed % len(rows)
        picked = [rows[(start + i) % len(rows)] for i in range(min(limit, len(rows)))]
        return [self._question_json(r, with_answer=with_answer) for r in picked]


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "math-drill"
    bridge: Bridge          # 由 make_server 注入（类属性）

    def log_message(self, fmt, *args):
        """写访问日志到 stderr（systemd 收到 /var/log/math-drill.log）。

        ⚠️ **必须抹掉 query 串**（2026-10-07 修，既存缺陷）：`/setup?t=<主 token>` 会把
        **主 token 明文**写进日志（实测生产日志 10 处、文件 0644，与 §13.3⑤「不记 token 值」相反）。
        治本在这里（记不出原文）；治标是 `/etc/tmpfiles.d/math-drill.conf` 的 0640（见 deploy/tmpfiles.d/）
        —— ⚠️ **不是** unit 里的 `LogFileMode`：那个指令**不存在**（2026-10-07 复核 F1 实测
        `systemd-analyze verify` 报 `Unknown key name`），写了等于没写、还会让 PID1 每次启动抱怨。
        不采用"只对 /setup 特判"：任何端点将来带敏感 query 都会同样泄漏，一律不记 query 更稳。
        """
        msg = fmt % args
        msg = re.sub(r"(/[^\s?]*)\?[^\s]*", r"\1", msg)     # `GET /setup?t=xx HTTP/1.1` → `GET /setup HTTP/1.1`
        sys.stderr.write("%s - %s\n" % (self.address_string(), msg))

    # ---- 公共
    def _send(self, status: int, body: dict, *, extra_headers: list[tuple[str, str]] | None = None):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        headers = list(extra_headers or [])
        # 滑动续期（v2.12）：已鉴权的请求顺带把 cookie 的有效期续上。
        # 为什么需要：浏览器对 cookie 寿命有硬顶（Chrome ≤ 400 天），改大 Max-Age 没用；
        # 续期后"只要偶尔用一次就永不过期"，配合"token 本身无过期"= 永久鉴权。
        if getattr(self, "_refresh_cookie", False):
            headers.append(("Set-Cookie", self.bridge.cookie_header()))
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _send_file(self, path: Path):
        ctype = {
            ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
            ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
        }.get(path.suffix, "application/octet-stream")
        data = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

    # ---- 引导端点（唯一不过 token 门）
    def _handle_setup(self, query: dict) -> None:
        b = self.bridge
        ip = self.client_address[0]
        if b.limiter.blocked_setup(ip):
            self._send(HTTPStatus.TOO_MANY_REQUESTS, {"error": "rate_limited"})
            return
        given = (query.get("t") or [""])[0]
        if given and hmac.compare_digest(given, b.token):
            b.limiter.clear_setup(ip)
            self._send(HTTPStatus.FOUND, {"ok": True},
                       extra_headers=[("Set-Cookie", b.cookie_header()), ("Location", "/")])
            return
        b.limiter.record_setup_failure(ip)
        self._send(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})   # 不回显任何信息

    # ---- 路由
    def _dispatch(self, method: str) -> None:
        b = self.bridge
        parsed = urlparse(self.path)
        path, query = parsed.path, parse_qs(parsed.query)

        if path == "/setup":
            self._handle_setup(query)
            return

        if path.startswith("/api/") or path.startswith("/m/"):
            if not b.limiter.hit_api(b.bucket_key(self)):
                self._send(HTTPStatus.TOO_MANY_REQUESTS, {"error": "rate_limited"})
                return
            if not b.authed(self):
                self._send(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                return
            # 滑动续期**只对浏览器**（评审 B2）：无条件置位会把浏览器会话值
            # 经 Set-Cookie 发给持 agent 凭据者 ⇒ §3.2 的"互不可替代"单向失效。
            self._refresh_cookie = b.identity(self) == "browser"

            if path == "/api/state":
                if method == "GET":
                    self._send(HTTPStatus.OK, b.store.get_blob())
                else:
                    payload = self._read_json()
                    try:
                        blob = b.store.put_blob(payload.get("base_version", -1),
                                                payload.get("data", {}))
                    except ConflictError as exc:
                        self._send(HTTPStatus.CONFLICT, {"error": "conflict", "latest": exc.latest})
                        return
                    self._send(HTTPStatus.OK, blob)
                return

            if path == "/api/daily" and method == "GET":
                blob = b.store.get_blob()
                # ADR-016 决策 4：**判定写死在这里** —— daily_questions/_question_json 都没有
                # request 上下文，identity 需要 handler ⇒ 只有这一层能算。
                # 判据 `== "browser"`（fail-closed）：只有已验证的浏览器会话拿得到 answer/analysis。
                # **不提供任何查询参数覆盖**（agent 无法自行索取答案）。
                with_answer = b.identity(self) == "browser"
                self._send(HTTPStatus.OK, {"server_version": blob["server_version"],
                                           "daily": blob["data"].get("daily"),
                                           "questions": b.daily_questions(with_answer=with_answer)})
                return

            if path == "/api/kp" and method == "GET":
                # ADR-016 决策 1：只读目录（把 kid 翻译成人话）。纯目录，无题目正文。
                self._send(HTTPStatus.OK, {"schemaVersion": 1, "items": b.store.list_kp()})
                return

            if path == "/api/attempts" and method == "GET":
                # ADR-016 决策 2：只读做题记录（复盘用）。只回判定结果与题号/考点，
                # **不回 stem/answer/analysis**；时间降粒度到"天"（不给秒级时间戳）。
                try:
                    days = max(1, min(365, int((query.get("days") or ["30"])[0])))
                    limit = max(1, min(500, int((query.get("limit") or ["200"])[0])))
                except ValueError:
                    self._send(HTTPStatus.BAD_REQUEST, {"error": ErrorCode.MALFORMED_REQUEST.value,
                                                        "message": "days/limit 必须是整数"})
                    return
                self._send(HTTPStatus.OK, b.attempts_summary(days=days, limit=limit))
                return

            if path == "/api/judge" and method == "POST":
                status, body = b.judge_request(self._read_json())
                self._send(status, body)
                return

            if path.startswith("/m/"):
                parts = [p for p in path.split("/") if p]
                if len(parts) != 3:
                    self._send(HTTPStatus.NOT_FOUND, {"error": "not_found"})
                    return
                root, name, rpc = parts
                # ⚠️ URL 的根段是 `m`（模块路由前缀），而装载器里的键是 `<根目录>/<名>`
                # （`modules/qbank`）—— **两者不是同一个字符串**。原实现直接拼 `m/<名>`，
                # 于是**任何**模块 rpc 都 404（既存用例只断言"没装载的模块要 404"，
                # 这条拼错就一直没红灯）。ADR-017 决策 7。
                key = next((k for k in (f"modules/{name}", f"generators/{name}")
                            if k in b.registry.loaded), f"modules/{name}")
                # 入参 = JSON body ⊕ 查询串（ADR-017 决策 6）。理由：模块 README 里写死的
                # 接口形态是 `GET /m/<模块>/<rpc>?k=v`，而 `_read_json()` 只读 body ——
                # 不合并的话查询串会被**静默丢弃**（模块只拿到 {}，还不报错）。
                # 同名参数**查询串优先**；GET 本来就没有 body，故不影响既有调用方。
                payload = self._read_json()
                payload.update({k: (v[-1] if isinstance(v, list) and v else v)
                                for k, v in query.items()})
                try:
                    out = b.registry.dispatch(key, rpc, payload, ctx=b.store)
                except KeyError as exc:
                    self._send(HTTPStatus.NOT_FOUND, {"error": "no_such_rpc", "message": str(exc)})
                    return
                except ValueError as exc:
                    # 模块用 ValueError 表示"入参不合法"（ADR-018 起有写 rpc，需要 400 这个档位：
                    # 没有它，模块一抛错就没人接，连接被直接掐掉，调用方看不到任何原因）。
                    self._send(HTTPStatus.BAD_REQUEST,
                               {"error": ErrorCode.MALFORMED_REQUEST.value, "message": str(exc)})
                    return
                self._send(HTTPStatus.OK, out if isinstance(out, dict) else {"result": out})
                return

            self._send(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return

        # 静态面（匿名可读；越权 403）
        fp, status = b.static_path(path)
        if status != HTTPStatus.OK or fp is None:
            self._send(status, {"error": "forbidden" if status == HTTPStatus.FORBIDDEN else "not_found"})
            return
        self._send_file(fp)

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PUT(self) -> None:
        self._dispatch("PUT")


def make_server(cfg: Config, bridge: Bridge) -> ThreadingHTTPServer:
    """建服务（测试用 port=0 拿随机端口；生产读 server.toml）。"""
    handler = type("BoundHandler", (Handler,), {"bridge": bridge})
    return ThreadingHTTPServer((cfg.bind_host, cfg.port), handler)


def build(repo: Path | str = REPO, *, phase: str = "1") -> tuple[Config, Bridge]:
    """装配：配置 + token + store + registry（启动失败即抛，不给半活状态）。"""
    repo = Path(repo)
    cfg = load_config(repo)
    token = load_token(cfg)
    store = Store(cfg.data_dir)
    registry = Registry(repo, phase=phase)
    registry.load_all()
    return cfg, Bridge(cfg, token, store, registry)


def main() -> int:
    cfg, bridge = build()
    srv = make_server(cfg, bridge)
    print(f"math-drill 起在 http://{cfg.bind_host}:{srv.server_port}"
          f"（已装载 {len(bridge.registry.loaded)} 个模块；静态根 {bridge.static_root}）",
          flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        bridge.store.close()
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
