# deploy/authelia —— 边缘鉴权（Authelia）的落地形态（ADR-021）

> ⚠️ **本目录只有模板，密钥与用户文件永不入仓**：真实文件在服务器的 `/root/authelia/`（700），
> 其中 `configuration.yml` 含 session/JWT/storage 三个密钥、`users_database.yml` 含 argon2id 哈希。

## 为什么是 Authelia（而不是自己写登录）

决策人要求"用成熟件、别造轮子"，而 `ADR-005` 又定死了**服务端零第三方依赖**（纯 stdlib `http.server`）——
Python 生态的认证框架（Flask-Login / FastAPI-Users…）嵌进来等于重写 bridge。**成熟件能直接落的位置是边缘层的 Caddy**：
我们在用 Caddy 终结 TLS，它天生支持 `forward_auth` 这套标准做法。

## 服务器上的形态（实测过的那个）

```
/root/authelia/                      # 700
├── configuration.yml                # 600（含三个密钥）
├── users_database.yml               # 600（argon2id 哈希，无明文）
├── db.sqlite3                       # Authelia 自己的存储（会话/regulation）
└── notification.txt                 # 文件后端"通知"（本部署不发邮件）
/root/set-authelia-password.sh        # 700 改密脚本（不回显、不落盘）
/root/authelia-initial-password.txt   # 600 首登口令（改完可删）
```

容器用 **`docker run`** 起（**不动**既有的 `docker-compose.yml`，避免波及 couchdb/vocab）：

```bash
docker run -d --name authelia --restart unless-stopped \
  --network obsidian-livesync_internal --network-alias authelia \
  -p 127.0.0.1:9091:9091 -v /root/authelia:/config authelia/authelia:latest
```

## ⚠️ 那个坑（踩过一次，整站 502）

`caddy-for-ols` 跑在 **host 网络**上 ⇒ 它**解析不到容器名 `authelia`**。
所以 Caddyfile 里 `forward_auth` 的上游必须写 **`127.0.0.1:9091`**（Authelia 已发布在回环），
写成 `authelia:9091` 的表现是**浏览器面 502**、而 agent 的 Bearer 路径照常 200（容易误判成 bridge 出问题）。

## Caddyfile 的接法（照 Authelia 官方 integration/proxies/caddy.md）

见 `deploy/caddy.block`：`math.zhu2006.xyz` 块里 `forward_auth` + `auth.zhu2006.xyz` 站点块。
关键一行是**把带 `Authorization` 头的服务间请求排除**（`not header Authorization *`），否则 DSH 插件会被登录页拦住。

## 开户 / 改密

```bash
# 开户（一条命令；口令落 600 文件，**默认不回显**）
ssh root@<server> 'bash /root/add-user.sh <用户名> [邮箱] [显示名]'
ssh root@<server> 'cat /root/authelia-newuser-<用户名>.txt'      # 取初始口令，交给对方
# 改密（交互输入，不回显）
ssh -t root@<server> /root/set-authelia-password.sh
```

脚本在 `deploy/authelia/add-user.sh`（服务器上装成 `/root/add-user.sh`，700）。它的三条纪律：

1. **初始口令不回显**：默认只写 `/root/authelia-newuser-<名>.txt`（600）并打印路径；
   要直接在终端看（你自己在服务器上执行时）用 `PRINT=1 bash add-user.sh <名>`。
2. **写完自检**：`grep -q "^  <名>:"` 必须命中，否则当场报错 —— ⚠️ 这里踩过坑：
   `users_database.yml` 的**末行可能没有换行符**，直接 `>>` 会把新用户**粘在上一行尾巴上**
   （YAML 变成一行乱码，且匹配不到 ⇒ 看起来像"静默没写进去"）；脚本先补一个换行再 append。
3. **改动前留备份**：`users_database.yml.bak-<时间戳>`，撤销测试号就是 `cp` 回去 + `docker restart authelia`。

新账号默认进 `users` 组（不是 `admins`）；他登录后看到的是**自己的空白控制台**
（多用户隔离：作答/blob/题库标记各归各的）。

## 回滚（一条命令级）

`cp -p /var/backups/math-drill/pre-authelia-<TS>/Caddyfile /root/obsidian-livesync/Caddyfile`
→ `docker exec caddy-for-ols caddy validate --config /etc/caddy/Caddyfile`
→ `caddy reload` → `docker stop authelia`
## ⚠️ 会话存储必须用 Redis（2026-10-09，决策人报"每次都要重新输密码"）

**症状**：决策人反馈"每次登录都还要重新输密码"。

**根因（实测）**：**Authelia 4.38 的会话默认存在进程内存里**（`storage.local` 那个 SQLite 只管认证日志/TOTP 等，
**不管会话**）⇒ 只要 Authelia 重启（我配置期间重启了七八次；服务器重启、容器升级同理），**所有人被踢下线**。
实测证据：同一 cookie，重启前 `/api/verify` **200** → 重启后 **302**（会话没了）。

**修法**：加一个只在 docker 内网可达的 Redis 存会话，并给 Authelia 配 `session.redis`：

```bash
# 口令落 600 配置文件，**不进容器 argv**（见下面「口令不进容器 argv」一节）
umask 077
RPW=$(head -c 32 /dev/urandom | sha256sum | cut -d' ' -f1)      # 不回显
printf '%s' "$RPW" > /root/authelia-redis-password.txt
printf '%s\n' "requirepass $RPW" 'appendonly yes' 'appendfsync everysec' 'dir /data' \
  > /root/authelia-redis/redis.conf
chown 999:0 /root/authelia-redis/redis.conf && chmod 600 /root/authelia-redis/redis.conf
docker run -d --name authelia-redis --restart unless-stopped \
  --network obsidian-livesync_internal --network-alias authelia-redis \
  -v /root/authelia-redis:/data \
  redis:7-alpine redis-server /data/redis.conf
```

```yaml
session:
  redis:                       # ← 少了这段，重启即掉线（默认内存态）
    host: authelia-redis
    port: 6379
    password: <见 /root/authelia-redis-password.txt，别打印>
```

**验收（三条都要过）**：登录 200 → 验证 200 → **重启 Authelia 后仍 200** → **重启 Redis 后仍 200**（AOF 兜住）。

**两个坑（都踩过）**
1. **纯 HTTP 上不下发会话 cookie**：Authelia 的会话 cookie 是 `Secure` 的，所以拿 `http://127.0.0.1:9091`
   做登录实验会看不到 `Set-Cookie`（我因此白测了两轮）——**实验必须走真实的 HTTPS 入口**。
2. **查配置别整段 `sed`**：`session` 段里有明文 Redis 密码，整段打印过一次（已轮换）；
   要看结构就 `sed -E 's/(password: ).*/\1<masked>/'`。

## ⚠️ 口令不许进容器 argv（2026-10-09，第二次泄漏之后加固）

**为什么**：Redis 口令原先写在 `docker run … redis-server --requirepass <口令>` 里 ⇒ 同一个值同时活在
**容器 argv / `docker inspect` / `docker events`** 三处。于是只要有人（包括我）为了查一条命令去翻
`docker events`，口令就随那行输出进会话——**2026-10-09 就是这么泄的第二次**（第一次是整段 `sed` 打出配置）。
两次都当场轮换了值。

**加固**：口令改落 `/root/authelia-redis/redis.conf`（600，`chown 999:0` —— 容器写 `/data` 用的就是这个身份），
容器只接一个参数 `redis-server /data/redis.conf`：

```bash
docker inspect authelia-redis -f '{{.Config.Cmd}}'    # ⇒ [redis-server /data/redis.conf]，零口令
```

**查会话数也别用 `redis-cli -a`**（`-a` 的值同样会进 `docker events`）——走 stdin 管道：

```bash
printf 'AUTH %s\nDBSIZE\n' "$(cat /root/authelia-redis-password.txt)" \
  | docker exec -i authelia-redis redis-cli --no-auth-warning | tail -1
```

**这轮轮换的账（含回滚）**：备份 `/var/backups/math-drill/pre-redis-rotate-20261009-204250/`
（旧 `configuration.yml` + `old-redis-password.txt`）⇒ 改 `configuration.yml` 的 `session.redis.password`
＋重写 `redis.conf` ＋ `docker rm -f` 重建 redis ＋ `docker restart authelia`。
**验收**：`DBSIZE` 5→5（重启前后会话原样还在，**决策人的登录态没被打断**）· 旧口令 `WRONGPASS` ·
新口令 `OK PONG` · 再单独重启一次 redis 后 `DBSIZE` 仍 ≥6（AOF 兜住）· 容器 argv 里 `grep` 口令 = 0 ·
`auth` 站 200 / `math` 站 302。

**同批修掉的一处陈旧**：`session.remember_me_duration` 自 4.38 起已被 `session.remember_me` 取代
（旧键会自动映射，但每次启动都报一条弃用告警）⇒ 已改名为新键，告警归零；备份 `pre-rememberme-20261009-204625/`。

## ⚠️ 长 URL 会撞 Authelia 的 4096 B 读缓冲 ⇒ 431（2026-10-09，DSH 前端"Failed to load plugins"）

**症状**：DSH 页面已经出来了，但界面报
`Failed to load plugins … client-modules: bundle script /plugins/??@deepseek-ai/…&rev=… failed to load?`

**根因（实测，不是猜）**：DSH 的客户端产物走"组合路由"，把 **45 个模块塞进同一条 URL**（实测 **2165 B**）。
Caddy 的 `forward_auth` 会把这条原始 URI 带去问 Authelia，再加上 cookie / UA / X-Forwarded-* 等请求头，
**整个请求头块超过了 fasthttp 默认的 4096 B 读缓冲**：

```
GET /api/authz/forward-auth??@deepseek-ai/dsh-typert-registry/client.js,…
→ status_code=431  error="error when reading request headers: fasthttp: small read buffer … buffer size=4096"
```

Authelia 回 431 ⇒ 浏览器拿不到那段 JS ⇒ 前端只能报"加载插件失败"。**控制台（`math.*`）不受影响，因为它的 URL 都很短**
——这也是为什么这个坑只在 DSH 上暴露。

**修法**（`/root/authelia/configuration.yml`，实测生效）：

```yaml
server:
  buffers:
    read: 16384      # 默认 4096：长 URL + cookie 组合会超
    write: 16384
```

**验收**：同一条 2165 B 的 bundle URL —— 改前 **431**；改后无名会 **302**（去登录页）、有会话 **200 / 3,764,501 B**。
旁证 `math` 302 / `auth` 200 / `reader` 401 均不变。备份 `pre-authelia-buffers-20261009-211119/`。

**教训**：`forward_auth` 的代价是"每个请求都要过一次鉴权服务"——**静态产物也会**。任何走 Caddy+Authelia 的站点，
只要单条 URL 或 cookie 长到把请求头推过 4 KB，就会以 431（而不是 404/403）的形态炸在浏览器里，且后端日志一片干净。
