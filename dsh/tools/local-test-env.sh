#!/usr/bin/env bash
# 起一个**干净的本地测试环境**：独立 DSH_HOME + 最小 profile（base + web-app + 我们的插件）。
#
# 为什么需要它：决策人的日常 DSH 装了十几个第三方插件（还有皮肤、桥接等），拿它验证我们的插件
# 会把"我们的问题"和"别人的问题"混在一起；而这个测试环境只装三样东西，等于把服务器上那种
# **轻量新环境**搬到本机。
#
# 用法：
#   bash dsh/tools/local-test-env.sh            # 建/刷新环境（幂等）
#   bash dsh/tools/local-test-env.sh start      # 建/刷新后**后台启动** web（默认端口 39192）
#   bash dsh/tools/local-test-env.sh stop       # 停掉它
#   bash dsh/tools/local-test-env.sh check      # 只做冒烟检查（需要已经在跑）
#
# 环境变量：
#   DSH_HOME     测试用的 DSH home（默认 ~/dsh-math-test，**不碰**你的 ~/.dsh）
#   PORT         监听端口（默认 39192 —— 避开你日常的 39191）
#   CREDENTIAL   服务间凭据文件来源（默认 ~/.dsh/math-drill/agent-credential）
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLUGIN="$REPO/dsh/math-drill-plugin"
# ⚠️ 必须 **export**：子进程（dsh / node）靠环境变量认 DSH_HOME。
# 2026-09-20 踩过：只赋 shell 变量时 `dsh plugin add` 会跑到真实的 ~/.dsh 上去，
# 于是"干净 profile"根本没建，而自检还在真 profile 上"通过"。
export DSH_HOME="${DSH_HOME:-$HOME/dsh-math-test}"
export PORT="${PORT:-39192}"
export CREDENTIAL="${CREDENTIAL:-$HOME/.dsh/math-drill/agent-credential}"
PROFILE="web"
ACTION="${1:-setup}"

# 用哪一个 dsh：优先 PATH 里的（你的 ~/.local/bin/dsh = 0.1.1-rc.1，与插件依赖链一致）
DSH_BIN="$(command -v dsh)"

say() { printf '%s\n' "$*"; }

setup() {
  say "测试环境 DSH_HOME=$DSH_HOME"
  say "dsh            = $DSH_BIN"
  mkdir -p "$DSH_HOME"

  # 1) 插件的宿主依赖：链到本机 DSH 安装树（不联网）
  node "$PLUGIN/tools/link-dsh-deps.mjs"

  # 2) 最小 profile：dsh plugin add 会在首次使用时初始化 base + web-app，并把我们追加进 bundles
  say "→ profile 目录：$DSH_HOME/profiles/$PROFILE"
  if ! grep -q '"@math-drill/dsh-plugin"' "$DSH_HOME/profiles/$PROFILE/package.json" 2>/dev/null; then
    say "→ 安装插件到 profile（首次会初始化 profile）"
    ( cd "$DSH_HOME" && "$DSH_BIN" plugin --profile "$PROFILE" add "$PLUGIN" )
  else
    say "→ 插件已在 profile 里（跳过安装）"
  fi

  # 3) 服务间凭据（0600）：只从本机既有文件**复制**，不回显任何值
  CRED_DEST="$DSH_HOME/math-drill/agent-credential"
  if [ -f "$CRED_DEST" ]; then
    say "→ 凭据已存在：$CRED_DEST（$(stat -c %a "$CRED_DEST")）"
  elif [ -f "$CREDENTIAL" ]; then
    mkdir -p "$DSH_HOME/math-drill" && chmod 700 "$DSH_HOME/math-drill"
    install -m 600 "$CREDENTIAL" "$CRED_DEST"
    say "→ 凭据已复制到 $CRED_DEST（600）"
  else
    say "⚠️ 找不到服务间凭据（$CREDENTIAL）—— 状态条与 /math 会回'未配置凭据'，其余功能照常"
  fi

  # 4) 只组合不启动：先证明它进了**这个测试 home** 的组合树（DSH_HOME 已 export）
  say "→ 组合树自检（home=$DSH_HOME）："
  "$DSH_BIN" --profile "$PROFILE" --dump-config 2>/dev/null | grep -A3 "math-drill-dsh" | sed 's/^/    /' || say "    ⚠️ 没在组合树里找到 math-drill-dsh"
}

start() {
  setup
  if pgrep -f "port $PORT" >/dev/null 2>&1; then
    say "⚠️ 端口 $PORT 上已有进程；先跑 stop"
    exit 1
  fi
  say "→ 后台启动（日志 /tmp/dsh-math-test.log）"
  ( cd "$DSH_HOME" && DSH_HOME="$DSH_HOME" setsid nohup "$DSH_BIN" web --no-open \
      --host 127.0.0.1 --port "$PORT" > /tmp/dsh-math-test.log 2>&1 < /dev/null & )
  sleep 25
  say "--- 启动日志尾部 ---"
  tail -3 /tmp/dsh-math-test.log | sed 's/^/    /'
  say "打开： http://127.0.0.1:$PORT"
  check || true
}

stop() {
  pkill -f "port $PORT" 2>/dev/null && say "已停（端口 $PORT）" || say "端口 $PORT 上没有进程"
}

check() {
  local base="http://127.0.0.1:$PORT"
  say "--- 冒烟检查 $base ---"
  if ! curl -sf -o /dev/null "$base/"; then
    say "❌ 服务没在跑（先 start）"; return 1
  fi
  say "✅ 首页 200"
  if curl -s "$base/" | grep -q "@math-drill/dsh-plugin"; then
    say "✅ boot roster 里有我们的插件"
  else
    say "⚠️ boot roster 里没找到我们的插件（组合或构建出了问题）"
  fi
  # ⚠️ 2026-10-08（ADR-024）：**客户端半边已删除** ⇒ 不再有 `/plugins/.../client.js` 可探，
  # 也没有只给状态条用的 `/math-drill/summary` 路由。这里改成验**宿主半边的组合**：
  # 插件进没进 `--dump-config`（工具是宿主侧注册的，组合树里出现即说明插件被加载）。
  local dump
  dump="$(cd "$DSH_HOME" && DSH_HOME="$DSH_HOME" "$DSH_BIN" --profile "$PROFILE" --dump-config 2>/dev/null | grep -c 'math-drill-dsh')"
  if [ "${dump:-0}" -ge 1 ]; then
    say "✅ 组合树里有 math-drill-dsh（宿主半边已加载）"
  else
    say "⚠️ 组合树里没有 math-drill-dsh —— 插件没被加载"
  fi
  say "    客户端产物与摘要路由**已按 ADR-024 删除**（404 属预期，不再是缺陷）"
}

case "$ACTION" in
  setup) setup ;;
  start) start ;;
  stop) stop ;;
  check) check ;;
  *) say "用法：$0 {setup|start|stop|check}"; exit 2 ;;
esac
