#!/usr/bin/env python3
"""dsh-math-go —— 「一键入口」：把当前 dsh web 的 launch token 拼成 302 跳转。

为什么需要它（2026-10-09）：DSH 的浏览器 UI 有一道**自带**的 token 门
（`authorizeIndex()` 只认 `?token=` 或它自己签发的 cookie），而这个 token **每次进程启动都换**。
于是「直接开域名」这件事就被卡住了：要么每次重启后手工去服务器取一次链接，要么把链接存成书签——但书签里的 token 会过期。

这个服务（只绑 127.0.0.1:39196）在**请求时**去读 dsh-math.log 里最新的 token。
外面由 Caddy + Authelia 挡着（`dsh.zhu2006.xyz`）⇒ 用户只需要记住一个地址、永远不用碰 token。

为什么回的是**一个会自己跳转的页面**、而不是 302（2026-10-09 实测改的）：
DSH 换 cookie 的响应是 `303 + Set-Cookie`。在"302 跳到另一个主机、再由那个主机回 303"的**重定向链**里，
curl 的 cookie jar **不会**把那个 cookie 落盘（实测：链末 200，但 jar 里只有 Authelia 的会话 cookie ⇒ 下一次请求 401）；
而"页面里 `location.replace()` 发起的**普通导航**"就完全等于用户手工打开那条链接（实测落盘、下一次 200）。
浏览器们大概率两者都行，但这条路上不需要赌。

纪律：**不打访问日志**（Location 头里带 token）。
"""

import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG_PATH = "/root/dsh-math.log"
APP_ORIGIN = "https://math-dsh.zhu2006.xyz"
LISTEN = ("127.0.0.1", 39196)
TOKEN_RE = re.compile(r"token=([A-Za-z0-9_-]+)")

PAGE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>正在进入研数 DSH…</title>
<meta http-equiv="refresh" content="0;url={target}">
<style>
  body {{ margin: 0; height: 100vh; display: grid; place-items: center;
         background: #0f1115; color: #c8ccd4;
         font: 15px/1.6 -apple-system, "Noto Sans SC", "Microsoft YaHei", sans-serif; }}
  a {{ color: #8ab4ff; }}
</style>
</head>
<body>
<p>正在进入研数 DSH…　若没有自动跳转，请点 <a href="{target}">这里</a>。</p>
<script>location.replace("{target}");</script>
</body>
</html>
"""


def latest_token() -> str:
    """读日志里最后一条 `token=…`。读不到就返回空串（调用方回 503）。"""
    last = ""
    try:
        with open(LOG_PATH, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                found = TOKEN_RE.findall(line)
                if found:
                    last = found[-1]
    except OSError:
        return ""
    return last


class Handler(BaseHTTPRequestHandler):
    server_version = "dsh-math-go/1"
    sys_version = ""

    def do_GET(self) -> None:  # noqa: N802（http.server 的既有命名）
        token = latest_token()
        if not token:
            body = "dsh-math-go: 没在日志里找到 launch token（dsh-math 起了吗？）\n".encode()
            self.send_response(503)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        body = PAGE.format(target=f"{APP_ORIGIN}/?token={token}").encode()
        self.send_response(200)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_HEAD = do_GET

    def log_message(self, *args) -> None:  # 静音：URL 里带 token
        return


if __name__ == "__main__":
    ThreadingHTTPServer(LISTEN, Handler).serve_forever()
