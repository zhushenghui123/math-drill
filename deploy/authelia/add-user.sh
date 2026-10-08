#!/usr/bin/env bash
# deploy/authelia/add-user.sh —— 给某个朋友开一个账号（Authelia 文件后端）
#
# 决策人原本的说法是"我生成邀请码、他们自己注册"；Authelia 文件后端没有注册页，
# 但**效果等价**：这里由管理员执行一次，生成初始口令 → 写入用户文件 → 重启生效，
# 然后把「网址 + 用户名 + 初始口令」交给对方（让他首次登录后自己改）。
#
# 用法（在服务器上，root）：
#   bash add-user.sh <用户名> [邮箱] [显示名]
# 约定：
#   · **口令不回显、不落盘**（只有 argon2id 哈希进用户文件；初始口令打在终端给你复制）；
#   · 幂等保护：同名用户已存在时**拒绝**（要改口令用 set-authelia-password.sh）；
#   · 与 ADR-021 一致：服务器只存哈希，**没有任何地方存明文**。
set -euo pipefail

USER_NAME="${1:?用法: add-user.sh <用户名> [邮箱] [显示名]}"
USER_MAIL="${2:-${USER_NAME}@localhost}"
USER_DISPLAY="${3:-$USER_NAME}"
USERS_FILE="${USERS_FILE:-/root/authelia/users_database.yml}"

[[ "$USER_NAME" =~ ^[A-Za-z0-9_-]{2,32}$ ]] || { echo "用户名只允许字母/数字/下划线/连字符（2-32 位）"; exit 1; }
grep -q "^  ${USER_NAME}:" "$USERS_FILE" 2>/dev/null && { echo "用户 ${USER_NAME} 已存在（改口令请用 set-authelia-password.sh）"; exit 1; }

# 生成初始口令（20 位，去掉了容易看错的字符），**只打印一次给管理员**
INIT_PW="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 20)"
HASH="$(docker exec authelia authelia crypto hash generate argon2 --password "$INIT_PW" | sed -n 's/^Digest: //p')"
[ -n "$HASH" ] || { echo "生成哈希失败（authelia 容器在吗？）"; exit 1; }

cp -p "$USERS_FILE" "${USERS_FILE}.bak-$(date +%Y%m%d-%H%M%S)"
# ⚠️ 2026-10-08 踩过：用户文件**末行可能没有换行符**，直接 `>>` 会把新用户**粘在上一行尾巴上**
#（YAML 变成一行乱码，且 `^  <名>:` 匹配不到 ⇒ 看起来像"静默没写进去"）。先补一个换行。
[ -n "$(tail -c 1 "$USERS_FILE")" ] && echo >> "$USERS_FILE"
cat >> "$USERS_FILE" <<YAML
  ${USER_NAME}:
    displayname: "${USER_DISPLAY}"
    password: "${HASH}"
    email: ${USER_MAIL}
    groups:
      - users
YAML

docker restart authelia >/dev/null && sleep 5
# 写完**自检**：用户必须真的进文件（宁可当场失败，也不要"看起来成功"）
grep -q "^  ${USER_NAME}:" "$USERS_FILE" || { echo "❌ 用户没写进 $USERS_FILE（改动前的备份在同目录）"; exit 1; }
curl -sf -o /dev/null http://127.0.0.1:9091/api/health && echo "✅ Authelia 已重启且健康"

# ⚠️ 初始口令**默认不打印**（打印会进终端历史/工单/会话；本项目红线：凭据不进会话），
#    而是落到 root 专属文件里由管理员自取。要直接在终端看（自己在服务器上执行时）：
#    PRINT=1 bash add-user.sh <用户名>
INFO_FILE="/root/authelia-newuser-${USER_NAME}.txt"
umask 077
cat > "$INFO_FILE" <<INFO
控制台：https://math.zhu2006.xyz    （会自动跳到登录页）
用户名：${USER_NAME}
初始口令：${INIT_PW}
首登后请自行修改：ssh -t root@<服务器> /root/set-authelia-password.sh ${USER_NAME}
INFO
chmod 600 "$INFO_FILE"
if [ "${PRINT:-0}" = "1" ]; then cat "$INFO_FILE"; else echo "  接入信息已写入 ${INFO_FILE}（600，仅 root 可读）——在服务器上 cat 取用"; fi

cat <<INFO

⚠️ 提醒：
  · 他登录后看到的是**自己的空白控制台**（多用户隔离已生效：作答/blob/题库标记各归各的）；
  · 若他要让 agent 陪练，需要 DSH 与一份 agent 凭据 —— 见 deploy/dsh-math/README.md；
  · 初始口令此刻只在本终端显示过一次，**服务器上没有明文**（只存 argon2id 哈希）。
INFO
