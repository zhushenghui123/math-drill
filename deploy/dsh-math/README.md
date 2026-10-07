# deploy/dsh-math —— 服务器上的「数学 DSH」实例（带我们的插件）

> **为什么要这个目录**：2026-10-07 这套东西是**在服务器上手工做出来的**（用户、单元、依赖链、凭据），
> 只在服务器上活着 ⇒ 换台机器就得重猜一遍。这里把它落成可复现的部署件，和 `deploy/authelia/` 同待遇。

## 形态（与决策人自己的阅读 agent 完全隔离）

| 项 | 值 | 阅读 agent（对比，**不许碰**） |
|---|---|---|
| systemd 单元 | `dsh-math.service` | `dsh-web.service` |
| 用户 | `mathdsh`（`useradd -r -m -d /home/mathdsh`） | `reader` |
| `DSH_HOME` | `/home/mathdsh/.dsh` | `/home/reader/.dsh` |
| 端口 | **39195**（只绑 `127.0.0.1`） | 3080 |
| 日志 | `/root/dsh-math.log`（**600**；里面有访问 token，别打印） | — |
| 访问链接 | `/root/dsh-math-access.txt`（600，`http://127.0.0.1:39195/?token=…`） | — |

## 怎么来的（`setup.sh` 就是这几步的可执行版）

1. **建用户 + 复制插件**：`cp -a /opt/math-drill/dsh/math-drill-plugin /home/mathdsh/`（插件从这里装进 profile）；
2. **链宿主依赖**（v2.16 记过的坑：`link:` 装的插件必须能解析到 `@deepseek-ai/*`，否则宿主**拒绝加载**）：
   服务器是全局 npm 安装，真位置在 `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`（223 个包）⇒
   `ln -sfn <该目录>/*  <插件>/node_modules/@deepseek-ai/`；
3. **补两个客户端包**：0.1.2 的 `dsh/package.json` **不声明** `dsh-client-ui-slots` / `dsh-client-ui-primitives`，
   而插件的客户端半边要它们 ⇒ `npm i -g --prefix /home/mathdsh/dsh-extra @deepseek-ai/dsh-client-ui-slots@0.1.0-rc.6 @deepseek-ai/dsh-client-ui-primitives@0.1.0-rc.6`
   再链进插件的 `node_modules`；
4. **服务间凭据**：由控制台 token 派生（值不回显）→ `/home/mathdsh/.dsh/math-drill/agent-credential`（600）；
5. **装单元并起服务**；访问走 SSH 隧道：`ssh -N -L 39195:127.0.0.1:39195 root@<服务器>` 后开那条带 token 的链接。

## 已知缺口（**未完成**，见任务书）

- **宿主半边 ✅**：`/math-drill/summary` 回真数据（今日题单/弱项/进度），三个只读工具已注册；
- **客户端半边 ❌**：boot roster 里没有本插件、`/plugins/@math-drill/dsh-plugin/client.js` **404** ⇒
  浏览器里**看不到状态条/小组件面板**。
  已排除「缺包」（补包后现象不变）与「宿主太新」（0.1.1 私有前缀起不来、且 0.1.1 的 npm 树里也没有 ui-slots）。
  ⇒ 待查 **0.1.2 如何枚举/挂载插件客户端半边**（`@deepseek-ai/dsh-client-modules` / `cordis-plugin-loader` / 生态声明样本）。
  任务书：`~/workspaces/claude/任务-math-drill-DSH0.1.2客户端半边适配-20261007.md`。

## 备份与回滚

- 本实例**不动**系统全局安装、**不动** `/home/reader`（阅读 agent）；
- 回滚 = `systemctl disable --now dsh-math.service` + 删单元（`rm` 由人工确认后执行）+ 保留 `/home/mathdsh/.dsh` 以便复查；
- 手工产物：`/home/mathdsh/dsh011`（0.1.1 的私有前缀，299 MB，**已确认无用可删**）、`/home/mathdsh/dsh-extra`（补的两个包，**要留**）。

## 复验命令

```bash
systemctl is-active dsh-math.service dsh-web.service
TOK=$(grep -o 'token=[A-Za-z0-9_-]*' /root/dsh-math.log | tail -1 | cut -d= -f2)
curl -s "http://127.0.0.1:39195/?token=$TOK" | grep -c '@math-drill/dsh-plugin'   # 期望 ≥1（当前 0 = 缺口）
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:39195/plugins/@math-drill/dsh-plugin/client.js?token=$TOK"
curl -s "http://127.0.0.1:39195/math-drill/summary?token=$TOK" | head -c 80        # 宿主半边应 ok:true
```
