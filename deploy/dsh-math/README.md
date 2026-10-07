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

## 状态：**宿主半边与客户端半边都合规**（2026-10-07 复核翻案后更正）

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
| 机械层结论 | 0.1.2 的 seed 表（`react`/`jsx-runtime`/`react-dom`/`cordis`/`store`/`ui-slots`/`ui-primitives` 等 8 个名字）把 `ui-slots`/`ui-primitives` 当**外壳内置词**而非 npm 包 ⇒ `setup.sh` 第 4 步对浏览器侧是空操作（`dsh-extra` 39 MB 疑似死重）；`inject` 里的悬空名**静默跳过、零影响**；两个槽位 key（`math_drill_*`）**不在占用表里**，加法式不冲突 |

**还剩的唯一未验项（P0，30 分钟，需真浏览器）**：开一个对话后 `document.querySelectorAll('[data-math-drill]').length ≥ 1`
—— ≥1 即关账；=0 才值得开新任务书，且嫌疑在**渲染/取数路径**，不在挂载契约。

## 备份与回滚

- 本实例**不动**系统全局安装、**不动** `/home/reader`（阅读 agent）；
- 回滚 = `systemctl disable --now dsh-math.service` + 删单元（`rm` 由人工确认后执行）+ 保留 `/home/mathdsh/.dsh` 以便复查；
- 手工产物：`/home/mathdsh/dsh011`（0.1.1 的私有前缀，299 MB，**已确认无用可删**）、`/home/mathdsh/dsh-extra`（补的两个包，**要留**）。

## 复验命令

```bash
systemctl is-active dsh-math.service dsh-web.service
TOK=$(grep -o 'token=[A-Za-z0-9_-]*' /root/dsh-math.log | tail -1 | cut -d= -f2)
# ⚠️ 三条纪律（初稿就是在这里造出假象的）：① 必须带 cookie jar；② 必须跟跳转（-L）；③ 别用单文件 URL
rm -f /tmp/cj; curl -sL -c /tmp/cj -b /tmp/cj -o /tmp/page.html -w '%{http_code} %{size_download}\n' \
  "http://127.0.0.1:39195/?token=$TOK"                       # 期望 200 / ≈24.5 KB
grep -c '@math-drill/dsh-plugin' /tmp/page.html              # 期望 ≥1（boot 图里含本插件）
grep -o '/plugins/??[^"]*math-drill[^"]*' /tmp/page.html | head -2   # 真实（组合）路由长这样
curl -s -b /tmp/cj "http://127.0.0.1:39195/math-drill/summary" | head -c 80   # 宿主半边应 ok:true
```
