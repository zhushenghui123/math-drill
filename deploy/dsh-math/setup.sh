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

echo "== 6b. 模型与 API key（2026-10-09）"
# 模型配置：只配一个 deepseek-flash（DeepSeek V4.1 Flash）—— 见 settings.yaml 里的成本纪律说明
install -o mathdsh -g mathdsh -m 600 "$(dirname "$0")/settings.yaml" /home/mathdsh/.dsh/settings.yaml
# key：DSH 自己会读 $DSH_HOME/.env（dsh-app-boot loadLayeredEnv）；缺了就照搬阅读 agent 的那把
if [ ! -s /home/mathdsh/.dsh/.env ] && [ -s /home/reader/.dsh/.env ]; then
  install -o mathdsh -g mathdsh -m 600 /home/reader/.dsh/.env /home/mathdsh/.dsh/.env
  echo "  已照搬阅读 agent 的 .env（600；值不回显）"
elif [ -s /home/mathdsh/.dsh/.env ]; then
  echo "  .env 已存在，保留（600）"
else
  echo "  ⚠️ 没有 .env：请手工放一把 OpenCode Go key 到 /home/mathdsh/.dsh/.env（OPENCODE_GO_API_KEY=…，600）"
fi

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

echo "== 7b. 一键入口（dsh.<域> → 本机 39196 → 302/自跳转到当前 token 链接）"
# 目的：用户只需要记一个地址（dsh.zhu2006.xyz），**永远不用碰 token**；token 每次重启由本服务现读。
# 前置：Caddyfile 里要有 dsh.<域> 的站块（deploy/caddy.block）+ DNS 记录；缺了不影响本实例本身。
install -m 755 "$(dirname "$0")/go-redirect.py" /usr/local/sbin/dsh-math-go
install -m 644 "$(dirname "$0")/dsh-math-go.service" /etc/systemd/system/dsh-math-go.service
systemctl daemon-reload
systemctl enable dsh-math-go.service >/dev/null
systemctl restart dsh-math-go.service
sleep 2
echo "  入口服务: $(systemctl is-active dsh-math-go.service)（仅回环 39196）"

echo "== 8. 访问链接（不回显；公网 + 回环各一份）"
# ⚠️ 修正 ④（同一类）：**先把链接取到临时文件，非空才 mv** —— 否则 grep 落空时
#    `> access.txt` 会先把好文件清空，留下一个空的访问链接（初稿就是这个毛病）
# ⚠️ 修正 ⑤（2026-10-09）：**每次 restart 都会换 token** ⇒ 两个链接文件必须同批刷新，
#    否则 access.txt 留着旧 token，读起来像"服务坏了"（今天就这么白查过一次）。
umask 077
TOK=$(grep -o 'token=[A-Za-z0-9_-]*' /root/dsh-math.log | tail -1)
if [ -z "$TOK" ]; then
  echo "  ⚠️ 没拿到 token 行（服务没起来？）——**没有覆盖旧文件**，去看 /root/dsh-math.log"; exit 1; fi
# ⚠️ 修正 ⑥（2026-10-09 决策人踩到 404）：`$TOK` 是 `token=…` 这一段，前面**必须**接 `?`。
#    写成 `/%s` ⇒ 得到 `/token=…`（被当成路径）⇒ 浏览器 404「找不到与以下网址对应的网页」。
TMP=$(mktemp /root/.dsh-math-url.XXXXXX)
printf 'http://127.0.0.1:39195/?%s\n' "$TOK" > "$TMP"
printf 'https://math-dsh.zhu2006.xyz/?%s\n' "$TOK" > "$TMP.pub"
mv "$TMP" /root/dsh-math-access.txt && chmod 600 /root/dsh-math-access.txt
mv "$TMP.pub" /root/dsh-math-public-url.txt && chmod 600 /root/dsh-math-public-url.txt
echo "  已写 /root/dsh-math-access.txt（回环）+ /root/dsh-math-public-url.txt（公网，600）"
echo "  ——服务器上 cat 取链接；公网那条要过 Authelia 登录；回环那条配 ssh -N -L 39195:127.0.0.1:39195 用"
