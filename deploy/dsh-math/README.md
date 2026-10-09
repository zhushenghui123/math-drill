# deploy/dsh-math —— 服务器上的「数学 DSH」实例（带我们的插件）

> **为什么要这个目录**：2026-10-07 这套东西是**在服务器上手工做出来的**（用户、单元、依赖链、凭据），
> 只在服务器上活着 ⇒ 换台机器就得重猜一遍。这里把它落成可复现的部署件，和 `deploy/authelia/` 同待遇。

## 形态（与决策人自己的阅读 agent 完全隔离）

| 项 | 值 | 阅读 agent（对比，**不许碰**） |
|---|---|---|
| systemd 单元 | `dsh-math.service` | `dsh-web.service` |
| 用户 | `mathdsh`（`useradd -r -m -d /home/mathdsh`） | `reader` |
| `DSH_HOME` | `/home/mathdsh/.dsh` | `/home/reader/.dsh` |
| 端口 | **39195**（只绑 `127.0.0.1`；公网入口见下 `math-dsh.zhu2006.xyz`） | 3080 |
| 日志 | `/root/dsh-math.log`（**600**；里面有访问 token，别打印） | — |
| 工作区（DSH 里选的那个文件夹） | **`/home/mathdsh/workspace`**（750，含一份 README 说明三条约定：不放凭据 / 不改插件代码 / 不碰生产库） | — |
| 日常入口 | **`https://dsh.zhu2006.xyz/`**（书签它就行；见下「一键入口」） |
| 直连链接 | `/root/dsh-math-public-url.txt`（600，`https://math-dsh.zhu2006.xyz/?token=…`）<br>`/root/dsh-math-access.txt`（600，回环版，给 SSH 隧道用） | — |

## 怎么来的（`setup.sh` 就是这几步的可执行版）

1. **建用户 + 复制插件**：`cp -a /opt/math-drill/dsh/math-drill-plugin /home/mathdsh/`（插件从这里装进 profile）；
2. **链宿主依赖**（v2.16 记过的坑：`link:` 装的插件必须能解析到 `@deepseek-ai/*`，否则宿主**拒绝加载**）：
   服务器是全局 npm 安装，真位置在 `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`（223 个包）⇒
   `ln -sfn <该目录>/*  <插件>/node_modules/@deepseek-ai/`；
3. ~~补两个客户端包~~ **（2026-10-08 起不再需要）**：那两步是为**插件的客户端半边**准备的；
   客户端半边已随 **ADR-024** 整体删除（展示都在控制台里）⇒ 第 4 步已从 `setup.sh` 移除，
   旧的 `dsh-extra`（39 MB）成为**可删的死重**（删之前确认没有任何进程引用它）。
4. **服务间凭据**：由控制台 token 派生（值不回显）→ `/home/mathdsh/.dsh/math-drill/agent-credential`（600）；
5. **装单元并起服务**。两条访问路径：
   - **公网（日常）**：`https://math-dsh.zhu2006.xyz/?token=…` —— 先过 Authelia 登录，再到 DSH 自己的 token 栅栏；
   - **SSH 隧道（应急/调试）**：`ssh -N -L 39195:127.0.0.1:39195 root@<服务器>` 后开回环版链接。

## 公网入口（2026-10-09 加，`math-dsh.zhu2006.xyz`）

决策人说"我先加个域名吧"，域名由我定、记录由我用 Caddy 容器里那把 Cloudflare token 直接建（不用去控制台点）。

| 件 | 值 |
|---|---|
| DNS | `A math-dsh.zhu2006.xyz → 101.43.18.37`，**DNS-only**（与 `math`/`reader`/`auth` 同款，不套 CDN） |
| Caddy 块 | `deploy/caddy.block` 的 `math-dsh.*` 段：`tls dns cloudflare` ＋ `forward_auth`（Authelia）＋ `reverse_proxy 127.0.0.1:39195` |
| 单元 | `ExecStart` 追加 `--trusted-host math-dsh.zhu2006.xyz` —— **不加这一条，反代过去是 401**（`/api` 的 browser-trust 栅栏只认已知 authority） |
| 证书 | Let's Encrypt，DNS-01 挑战（Caddy 自签，实测 ~16 s 拿到；有效期至 2027-01-07） |

**验收（2026-10-09 实测）**：公网无会话 → **302** 去 `auth.zhu2006.xyz` · 带 `Authorization` 头（绕 forward_auth，只测通路）→ DSH 自己的 **401** · 带当前 token ＋ cookie jar → **200 / 24233 B**（`<title>DeepSeek Harness</title>`） · 回环带 token → **303** · 旁证：`math` 302 / `reader` 401 / `auth` 200 **均未被带坏**。

> ⚠️ **首次打开还可能在界面里看到 `Failed to load plugins`** —— 那不是插件的问题，是 **Authelia 的 4096 B 读缓冲**
> 被那条 2165 B 的组合 bundle URL 撞了（`431 Request Header Fields Too Large`）。**已在 `deploy/authelia/README.md` 记根因与修法**
> （`server.buffers.read: 16384`），2026-10-09 已落生产验证：同一条 URL 431 → 302/200。

**⚠️ 这一轮踩的坑（纪律，写进结构）**：验证公网跳转时我用了 `curl -w '%{redirect_url}'`，而那个 302 的 `rd=` 参数里**带着 token** ⇒ token 进了会话。
处置：**当场 `systemctl restart dsh-math` 换掉 token**（旧 token 实测 401 = 已死），并刷新两个链接文件；
**以后查跳转只看 `%{http_code}`，别看 `%{redirect_url}`**（要看也得先掩码）。

### 那道"还要 token"的门是怎么回事（2026-10-09 决策人问"直接访问域名不行吗"）

> ⚠️ **链接格式（2026-10-09 决策人真的踩到 404）**：token 是查询参数，必须写 **`/?token=…`**。
> 我第一版写链接文件的脚本漏了 `?`，生成出 `/token=…` ⇒ 被 DSH 当成路径 ⇒ 浏览器报
> 「找不到与以下网址对应的网页」（**不是 DNS 问题**，记录当时是好的）。实测对照：`/token=…` = **404**，
> `/?token=…` = **303 → 200**。已在 `setup.sh` 里改成 `printf 'https://math-dsh.zhu2006.xyz/?%s\n' "$TOK"`
> 并加注释（`$TOK` 自带 `token=` 前缀，所以只需补 `?`）。

**两道门，第二道是 DSH 自己的**：浏览器进来先过 Authelia（登录），过了之后 DSH 还会回一句
`401 dsh web authentication required; reopen the URL printed by dsh web.` —— 这不看 Host/Origin，
带 `--trusted-host` 也没用（实测：带可信 Host 不带 token = 401；带 Origin/Referer 伪浏览器 = 401；带 token = 303）。
`--trusted-host` 管的是另一件事：`/api` 的 Host/Origin 栅栏（`isTrustedApiRequest`）。
DSH 也没有"关掉这道门"的开关（`dsh web --help` 只有 `--host/--port/--trusted-host/--no-open`）。

**但它只需要用一次**（源码 + 实测都确认）：

| 事实 | 依据 |
|---|---|
| `?token=` 只在 `GET /` 时兑换成 cookie，然后 303 跳到干净的 `/` | `authorizeIndex()`：`sessionCookie(...)` + `location: "/"` |
| cookie 寿命 **30 天** | `cookieMaxAgeDays` 默认 30 ⇒ 实测响应头 `Max-Age=2592000`（Expires 2026-11-08） |
| cookie 的签名密钥**落盘**（存在 Web profile 的 credentials 里，不是每次启动随机） | `initializeSecret()` → `credentials.modifyRecord(AUTH_RECORD_KEY, …)` |
| ⇒ **重启实例、换 launch token，老 cookie 照样有效** | 实测：token 链接换 cookie（200）→ 只用 cookie 访问（200）→ `systemctl restart`（token 已变）→ 旧 cookie **仍 200**，而裸域名无 cookie **401** |

所以日常姿势是：**第一次** `ssh … 'cat /root/dsh-math-public-url.txt'` 打开那条链接换成 cookie，
之后**直接开 `https://math-dsh.zhu2006.xyz/`**（建议存书签），直到 30 天后 cookie 过期、或你自己清了 cookie，再走一次。

### 一键入口 `dsh.zhu2006.xyz`（2026-10-09，决策人："正常不是我直接访问域名进网站就够了吗？"）

**问题**：上面那道 token 门 + "token 每次重启都换"，导致"直接开域名"要么 401，要么得反复 SSH 取链接。

**做法**：新增 `dsh.zhu2006.xyz`（DNS `A → 服务器`，DNS-only）＋ Caddy 块（Authelia 同款）＋ 本机小服务
`/usr/local/sbin/dsh-math-go`（源件 `deploy/dsh-math/go-redirect.py`，systemd 单元 `dsh-math-go.service`，**只绑 `127.0.0.1:39196`**）。
它每次请求**现读** `dsh-math.log` 最后一条 `token=…`，回一个**自己会跳转的页面**（页面里有 `location.replace()` 与一个兜底链接）。

**用户的姿势**：书签 `https://dsh.zhu2006.xyz/` → Authelia 登录（30 天 cookie）→ 自动跳进 DSH（DSH 自己的 cookie 也是 30 天）。
⇒ 从今往后"直接开域名"就够了；**token 的轮换对用户完全不可见**（重启后入口自己指向新 token，实测）。

**为什么是"页面自跳转"而不是 302（实测记录，别改回去）**：DSH 的 cookie 是在 `303 + Set-Cookie` 上发的。
在"302 跳到另一个主机、再由那台主机回 303"的**重定向链**里，curl 的 cookie jar **不落**那个 cookie
（实测：链末 200，但 jar 里只剩 Authelia 的会话 cookie ⇒ 下一次请求 401）；改成"页面自己 `location.replace()` 发起一次普通导航"后，
落盘 + 下一次 200（与用户手工打开那条链接是同一条路径）。浏览器多半两种都行，但这条路上不需要赌。

**验收（2026-10-09 实测）**：入口页 `200 + cache-control: no-store`（经 Authelia；无会话则 302）·
页内目标链接指向当前 token（掩码核对）· 按浏览器两步走：导航过去 `303` → jar 里出现 `#HttpOnly_math-dsh.zhu2006.xyz` → 裸域名 **200** ·
`systemctl restart dsh-math` 换 token 后，入口**自动**指向新 token（无需人工）· 旁证 `math-dsh`/`math`/`auth` 未受影响。

## 状态：**插件已收敛为「只做数据面」**（2026-10-08，ADR-024）

## 模型与凭据（2026-10-09 补上——决策人问"怎么没有配 API key"）

**只配一个模型**：`deepseek-flash` = **DeepSeek V4.1 Flash（OpenCode Go）**，与 Codex / Claude 同款。
理由（决策人定的成本纪律）：**其他模型可能很贵**，模型选择器里多列一个就多一次误选的机会 ⇒ provider 表里只留这一个。

| 件 | 位置 | 说明 |
|---|---|---|
| 模型/provider | `$DSH_HOME/settings.yaml`（600） | 源件：`deploy/dsh-math/settings.yaml`（**无凭据**，只有 `apiKeyEnv` 这个环境变量名） |
| 默认模型 | 同上 `agent-default-model:` | `provider: opencode-go` / `model: deepseek-flash` |
| **API key** | `$DSH_HOME/.env`（600，`OPENCODE_GO_API_KEY`） | 照搬**阅读 agent** 的那把（决策人："可以直接照搬阅读 agent 的 API"）。**永不入仓** |

**为什么不用 systemd 的 `EnvironmentFile`**：DSH 自己会加载 `$DSH_HOME/.env`
（`dsh-app-boot` 的 `loadLayeredEnv()`：project 层 = 调用目录 `.env`，user 层 = `$DSH_HOME/.env`，继承的环境优先）。
阅读 agent 也是这么工作的（它的单元里同样没有 `EnvironmentFile`）。

**验收（2026-10-09 实测）**：`GET https://opencode.ai/zen/go/v1/models` → **200**，38 个模型里含 `deepseek-flash` ·
`POST /chat/completions`（模型 `deepseek-flash`）→ **200，返回 `model: deepseek-flash`**，42 tokens ·
实例重启后 `active`、日志无报错。

> ⚠️ **provider 要求 `x-opencode-session` 头**（阅读 agent 配置里就有 `x-opencode-session: dsh-harness-session`）：
> 少了它服务端回 **400 MissingSessionID**——第一次手测时就踩了这个（不是 key 的问题）。
>
> ⚠️ **`.env` 是凭据文件**：`600`，只在服务器上，不进仓库、不进会话；要换 key 直接改这个文件再 `systemctl restart dsh-math`。

> **本节历史**：10-07 经历了一次"我把三条测量假象当成缺口"的翻案（下留痕）；10-08 决策人直接拍板
> **删掉整个客户端半边** —— 状态条 / 小组件面板 / 构建链 / 平台模块表 / 只读摘要路由全撤，
> 只留"替 agent 打通数据通路"（三个读工具 + 两个写白名单工具 + `/math` 命令）。
> 因此下面那些关于"客户端半边合规性"的考据，**现在只作历史留档**（不再有客户端半边可挂载）。
>
> ### 历史留档：宿主半边与客户端半边都合规（2026-10-07 复核翻案后更正）

> ⚠️ **本节曾写错，留痕**：初稿写「客户端半边 ❌ 不被挂载」，依据是两条**测量假象**——
> **(a)** 在 **303 空壳**响应上 grep（没跟重定向）⇒ 自然零命中；
> **(b)** 用**单文件 URL** `/plugins/<包>/client.js` 取产物 —— 0.1.2 走**组合路由**，单文件 URL **按设计就 404**。
> 另有一次没带 cookie jar（`?token=` 会下发会话 cookie，跟跳转后必须带上）⇒ 401。
> **三次测量错三次，缺口是我造出来的。** 复核（`~/workspaces/claude/复核报告-math-drill-DSH0.1.2客户端半边适配-20261007.md`）
> 逐行读通了 0.1.2 的客户端管线并翻案；我方复现如下。

**正确的实测（可复跑，见文末命令）**：

| 项 | 实测 |
|---|---|
| 整页（带 cookie 跟跳转） | **200 / 24573 B** |
| boot 图是否含本插件 | **含**——组合路由里 `…,@math-drill/dsh-plugin/client.js,…&rev=12bbc973f5f1`，另有本插件自己的组合 `/plugins/??@math-drill/dsh-plugin/client.js&rev=6894edaa2d6f4e0f-45` |
| 宿主半边 | `/math-drill/summary` 回真数据（今日题单/弱项/进度），三个只读工具已注册 |
| 机械层结论（历史） | 0.1.2 的 seed 表（`react`/`jsx-runtime`/`react-dom`/`cordis`/`store`/`ui-slots`/`ui-primitives` 等 8 个名字）把 `ui-slots`/`ui-primitives` 当**外壳内置词**而非 npm 包；`inject` 里的悬空名**静默跳过、零影响**。⇒ 这些现在都**无关了**：客户端半边已删除（ADR-024） |

**（2026-10-09 追记）那条"唯一未验项"已随 ADR-024 作废**：客户端半边整体删除后，页面上**不再有任何本插件的 DOM 标记** ——
实测整页 `grep -c math-drill` = **0**、旧的 `/math-drill/summary` 路由 **404**。
**这不是缺口，是删除后的正确形态**；再拿 `[data-math-drill]` 当验收判据，就是自己给自己造红灯。
插件的验收判据已改为**数据面**（见文末「复验命令」）。

## 备份与回滚

- 本实例**不动**系统全局安装、**不动** `/home/reader`（阅读 agent）；
- 回滚 = `systemctl disable --now dsh-math.service` + 删单元（`rm` 由人工确认后执行）+ 保留 `/home/mathdsh/.dsh` 以便复查；
- 手工产物：`/home/mathdsh/dsh-extra`（39 MB，当年给客户端半边补的两个包）—— **2026-10-09 实测零引用**
  （profile / 单元 / 插件 package.json 里都不出现）⇒ **死重，可删**；
  `dsh011`（0.1.1 的私有前缀）在本机上已不存在。

## 复验命令（2026-10-09 换判据：**看数据面，不看 DOM**）

```bash
# ① 两个实例都活着、且各在各的用户下（隔离）
systemctl is-active dsh-math.service dsh-web.service          # 期望 active active
systemctl show -p User --value dsh-math.service               # 期望 mathdsh
systemctl show -p User --value dsh-web.service                # 期望 reader
runuser -u mathdsh -- ls /home/reader/.dsh  2>&1 | head -1    # 期望 Permission denied
runuser -u reader  -- ls /home/mathdsh/.dsh 2>&1 | head -1    # 期望 Permission denied

# ② 我们的插件进了组合树 —— 这才是"插件装上了"的判据（只组合不启动）
runuser -u mathdsh -- env DSH_HOME=/home/mathdsh/.dsh HOME=/home/mathdsh \
  dsh --profile web --dump-config | grep -A6 math-drill-dsh

# ③ 数据面真的通（agent 凭据 → 控制台；**凭据值不回显**）
runuser -u mathdsh -- bash -c 'C=$(cat /home/mathdsh/.dsh/math-drill/agent-credential);
  for p in /api/state /api/kp; do printf "%s -> " "$p";
  curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $C" http://127.0.0.1:8081$p; done'   # 期望 200 200

# ④ DSH 网页面（必须带 cookie jar 跟跳转；token 不回显）
TOK=$(grep -o 'token=[A-Za-z0-9_-]*' /root/dsh-math-access.txt | cut -d= -f2)
rm -f /tmp/cj; curl -sL -c /tmp/cj -b /tmp/cj -o /tmp/p.html -w '%{http_code} %{size_download}\n' \
  "http://127.0.0.1:39195/?token=$TOK"                        # 期望 200 / ≈24 KB
grep -c math-drill /tmp/p.html                                # 期望 0（**页面无痕迹是对的**，ADR-024 删了客户端半边）

# ⑤ 公网入口（Authelia 之后 + DSH 自己的 token 栅栏）
curl -s -o /dev/null -w '%{http_code}\n' https://math-dsh.zhu2006.xyz/     # 无会话：期望 302（去登录页）
TOK=$(grep -o 'token=[A-Za-z0-9_-]*' /root/dsh-math-public-url.txt | cut -d= -f2)
rm -f /tmp/cj2; curl -sL -c /tmp/cj2 -b /tmp/cj2 -H 'Authorization: Bearer bypass' -o /tmp/p2.html \
  -w '%{http_code} %{size_download}\n' "https://math-dsh.zhu2006.xyz/?token=$TOK"   # 期望 200 / ≈24 KB
# ⚠️ 上面两条都**只打 %{http_code}**：302 的 %{redirect_url} 里带 token（踩过，当场换过 token）
```

## 2026-10-09 复验记录（决策人问"DSH 带插件上服务器了吗 / 隔离严不严"）

| 项 | 实测 |
|---|---|
| 三服务 | `math-drill` / `dsh-web` / `dsh-math` 全 **active** |
| 插件树一致性 | 本地仓 ↔ `/home/mathdsh/math-drill-plugin` **逐文件 md5 相同**（11 个文件，`--delete` 同步，无客户端半边残留） |
| 组合树 | `dsh --profile web --dump-config` 里 `math-drill-dsh` + `baseUrl: https://math.zhu2006.xyz` + `credentialPath` 在读 |
| 数据面 | agent 凭据 → `/api/state` **200**、`/api/kp` **200**（桥接真通，不是纸面） |
| 隔离 | `mathdsh ↛ /home/reader/.dsh`、`reader ↛ /home/mathdsh/.dsh` **双向 Permission denied**；端口 39195 / 3080 **只绑回环** |
| 服务器健康 | load 0.11 · 内存 1801/3723 MB（可用 1921）· 磁盘 35% · Docker 5 容器 healthy |
| 网络暴露面 | 那次体检时（20:38）**还没有**公网入口；当晚 20:52 加了 `math-dsh.zhu2006.xyz`（Caddy + Authelia，见上一节） |
