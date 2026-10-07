#!/usr/bin/env bash
# deploy/dsh-math/setup.sh —— 在服务器上把「数学 DSH」实例建起来（幂等；不动阅读 agent）
# 用法（在服务器上，root）：bash setup.sh
set -euo pipefail

PLUGIN_SRC="${PLUGIN_SRC:-/opt/math-drill/dsh/math-drill-plugin}"
PLUGIN_DST="${PLUGIN_DST:-/home/mathdsh/math-drill-plugin}"
HOST_TREE="${HOST_TREE:-/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai}"
EXTRA_PREFIX="${EXTRA_PREFIX:-/home/mathdsh/dsh-extra}"
TOKEN_FILE="${TOKEN_FILE:-/etc/math-drill/token}"
REPO="${REPO:-/opt/math-drill}"

echo "== 1. 专用用户（与阅读 agent 的 reader 隔离）"
id mathdsh >/dev/null 2>&1 || useradd -r -m -d /home/mathdsh -s /bin/bash mathdsh

echo "== 2. 插件副本"
[ -d "$PLUGIN_DST" ] || cp -a "$PLUGIN_SRC" "$PLUGIN_DST"
chown -R mathdsh:mathdsh "$PLUGIN_DST"

echo "== 3. 宿主依赖链（不链 ⇒ 宿主拒绝加载插件）"
DEST="$PLUGIN_DST/node_modules/@deepseek-ai"
mkdir -p "$DEST"
ln -sfn "$HOST_TREE"/* "$DEST"/ 2>/dev/null || true

echo "== 4. 补两个客户端包（0.1.2 的 dsh 不声明它们）"
su -s /bin/bash mathdsh -c "export PATH=/usr/bin:\$PATH; npm i -g --prefix $EXTRA_PREFIX \
  @deepseek-ai/dsh-client-ui-slots@0.1.0-rc.6 @deepseek-ai/dsh-client-ui-primitives@0.1.0-rc.6" >/dev/null
for d in "$EXTRA_PREFIX"/lib/node_modules/@deepseek-ai/*; do ln -sfn "$d" "$DEST/$(basename "$d")"; done
chown -R mathdsh:mathdsh "$DEST"

echo "== 5. profile 与插件安装（独立 DSH_HOME）"
su -s /bin/bash mathdsh -c "export DSH_HOME=/home/mathdsh/.dsh; export PATH=/usr/bin:\$PATH; \
  cd $PLUGIN_DST && node tools/link-dsh-deps.mjs >/dev/null 2>&1 || true; \
  grep -q '@math-drill/dsh-plugin' \$DSH_HOME/profiles/web/package.json 2>/dev/null \
    || dsh plugin --profile web add $PLUGIN_DST"

echo "== 6. 服务间凭据（从控制台 token 派生，值不回显）"
mkdir -p /home/mathdsh/.dsh/math-drill && chmod 700 /home/mathdsh/.dsh/math-drill
CRED=$(cd "$REPO" && MATH_DRILL_TOKEN_FILE="$TOKEN_FILE" python3 -c \
  "import sys;sys.path.insert(0,'.');from bridge.api import load_config,load_token,agent_value;print(agent_value(load_token(load_config())))")
install -o mathdsh -g mathdsh -m 600 /dev/stdin /home/mathdsh/.dsh/math-drill/agent-credential <<< "$CRED"
unset CRED

echo "== 7. systemd 单元"
install -m 644 "$(dirname "$0")/dsh-math.service" /etc/systemd/system/dsh-math.service
install -m 600 /dev/null /root/dsh-math.log
systemctl daemon-reload && systemctl enable --now dsh-math.service
sleep 25
echo "  服务: $(systemctl is-active dsh-math.service)"
echo "  阅读 agent（应仍 active）: $(systemctl is-active dsh-web.service)"

echo "== 8. 访问链接（不回显）"
grep -o 'http://127.0.0.1:39195/?token=[A-Za-z0-9_-]*' /root/dsh-math.log | tail -1 > /root/dsh-math-access.txt
chmod 600 /root/dsh-math-access.txt
echo "  已写 /root/dsh-math-access.txt（600）——在服务器上 cat 取链接，本机用 ssh -N -L 39195:127.0.0.1:39195 开隧道"
