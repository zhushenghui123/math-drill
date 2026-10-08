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

echo "== 2. 插件副本（**先清掉展示半边的残留**：旧副本里可能还有客户端半边，cp 只增不删）"
[ -d "$PLUGIN_DST" ] || cp -a "$PLUGIN_SRC" "$PLUGIN_DST"
rm -rf "$PLUGIN_DST/src/client" "$PLUGIN_DST/src/shared" "$PLUGIN_DST/lib" "$PLUGIN_DST/build" \
       "$PLUGIN_DST/tsdown.config.ts" "$PLUGIN_DST/tools/build-client.mjs" \
       "$PLUGIN_DST/tests/client-bundle.test.mjs" "$PLUGIN_DST/tests/client-runtime.test.mjs"
chown -R mathdsh:mathdsh "$PLUGIN_DST"

echo "== 3. 宿主依赖链（不链 ⇒ 宿主拒绝加载插件）"
DEST="$PLUGIN_DST/node_modules/@deepseek-ai"
mkdir -p "$DEST"
ln -sfn "$HOST_TREE"/* "$DEST"/ 2>/dev/null || true

# == 4. （已删除）补两个客户端包 —— 那两步是为**插件的客户端半边**准备的；
#    客户端半边已随 ADR-024 整体删除 ⇒ 这里不再需要。若目标机上还留着旧的 `dsh-extra`，它是**死重**，可自行清理。
echo "== 4. 跳过（客户端半边已删除，ADR-024；旧 $EXTRA_PREFIX 属死重）"

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
# ⚠️ 三处幂等修正（2026-10-07 复核指出）：
#   ① **不许先清空日志**：清了之后若启动失败，日志里就没有 token 行 ⇒ 下一步写出的访问链接是空的；
#   ② 单元被改过时 `enable --now` **不会重启**已在跑的进程 ⇒ 必须显式 restart；
#   ③ 日志用追加（`>>`），取**最后一条** token 行即可（不用清）。
install -m 600 /dev/null /root/dsh-math.log
systemctl daemon-reload && systemctl enable dsh-math.service >/dev/null
systemctl restart dsh-math.service
sleep 25
echo "  服务: $(systemctl is-active dsh-math.service)"
echo "  阅读 agent（应仍 active）: $(systemctl is-active dsh-web.service)"

echo "== 8. 访问链接（不回显）"
# ⚠️ 修正 ④（同一类）：**先把链接取到临时文件，非空才 mv** —— 否则 grep 落空时
#    `> access.txt` 会先把好文件清空，留下一个空的访问链接（初稿就是这个毛病）
umask 077
TMP=$(mktemp /root/.dsh-math-access.XXXXXX)
grep -o 'http://127.0.0.1:39195/?token=[A-Za-z0-9_-]*' /root/dsh-math.log | tail -1 > "$TMP"
if [ -s "$TMP" ]; then mv "$TMP" /root/dsh-math-access.txt; chmod 600 /root/dsh-math-access.txt
  echo "  已写 /root/dsh-math-access.txt（600）——服务器上 cat 取链接，本机 ssh -N -L 39195:127.0.0.1:39195 开隧道"
else echo "  ⚠️ 没拿到 token 行（服务没起来？）——**没有覆盖旧的 access.txt**，去看 /root/dsh-math.log"; rm -f "$TMP"; exit 1; fi
