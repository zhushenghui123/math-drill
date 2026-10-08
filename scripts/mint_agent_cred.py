"""scripts/mint_agent_cred.py —— 给某个用户**下发一把 agent 凭据**（每人一把，多用户隔离）。

规格：ADR-021（边缘鉴权与身份下沉）· `core/store.py` 的 `agent_creds` 表（`schema_version = 6`）。

为什么要它：agent 侧（DSH 插件）原先只有**一把实例级凭据**，所有服务间请求都归 `owner`
⇒ 朋友一旦装 DSH，他的 agent 会读到**你的**统计。现在每人一把：凭据原文只在**下发这一刻**出现，
服务器只留 `sha256`。

用法（在服务器上，通常由 `deploy/dsh-math/setup.sh` 或管理员手工调用）：
    python3 scripts/mint_agent_cred.py --user alice --data-dir /var/lib/math-drill \
        --out /home/alice/.dsh/math-drill/agent-credential

· `--user` 必须是**逻辑用户名**（与 Authelia 的 `Remote-User` 同名，管理员就是 `owner`）；
· `--out` 写了就顺手把**原文**落到该文件（600，目录自动建）——目标机器上的 DSH 直接读它；
· 不给 `--out` 时**只打印哈希前缀**（不回显原文），适合只想登记、不想在本机留一份的场景。
"""

from __future__ import annotations

import argparse
import secrets
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from core.store import Store  # noqa: E402

__all__ = ["mint"]


def mint(*, user: str, data_dir: str) -> str:
    """生成一把新凭据、登记到 `user` 名下，返回**原文**（调用方负责落盘/交付）。"""
    raw = secrets.token_hex(32)          # 64 位十六进制 = 256 bit
    store = Store(data_dir)
    try:
        store.set_agent_cred(user=user, raw=raw, label="minted")
    finally:
        store.close()
    return raw


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="下发一把 per-user agent 凭据（agent_creds）")
    ap.add_argument("--user", required=True, help="逻辑用户名（与 Authelia 的 Remote-User 同名；管理员=owner）")
    ap.add_argument("--data-dir", required=True, help="**必填**：绝不默认写生产库")
    ap.add_argument("--out", default=None, help="把凭据原文写到这里（600）；不给则只登记不回显")
    args = ap.parse_args(argv)

    raw = mint(user=args.user, data_dir=args.data_dir)
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.touch(mode=0o600)
        out.chmod(0o600)
        out.write_text(raw + "\n", encoding="utf-8")
        print(f"✅ 已为 {args.user} 下发凭据 → {out}（600，值未回显）")
    else:
        print(f"✅ 已为 {args.user} 登记凭据（sha256 前缀 {raw[:8]}…，值未回显）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
