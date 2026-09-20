# `dsh/` —— 考研数学 × DeepSeek Harness（ADR-015 的代码落点）

**这里是什么**：`docs/DECISIONS.md` 的 **ADR-015** 定的顶层域。形态是「**以 DSH 为宿主，考研数学做插件**」，
本目录放**插件侧**的全部代码；math-drill 的 Python 服务（判定 / 存储 / 题库）**一行不动**——它是判定与数据的
唯一权威，agent 只在**讲解侧**。

## 目录

```
dsh/
├── README.md                      # 本文件
├── 参考-官方文档与生态.md          # ★ 官方 Skill/文档 + 社区对标物 + 逐条对照我们的实现（2026-09-20 调研）
└── math-drill-plugin/             # 桥接插件（宿主半边 + 客户端半边；Phase A/B 均已落地）
    ├── package.json               # dsh.bundle.patch 声明 ⇒ `dsh plugin add` 会自动挂进 profile 的 bundles
    ├── cordis.patch.yml           # bundle 补丁：往组合树里 insert 一行（含 config）
    ├── README.md                  # 安装 / 配置 / 凭据 / 工具面
    ├── src/
    │   ├── index.js               # cordis 插件（宿主半边）：name / inject / Config / apply + 只读状态路由
    │   ├── credential.js          # 服务间凭据读取（0600 校验；**永不打印**）
    │   ├── math-drill-api.js      # math-drill HTTP 客户端（**只读**：GET /api/state、/api/daily）
    │   ├── shared/contract.js     # ★ 两半共用契约（STATE_PATH / schemaVersion / isStateResponse）
    │   ├── summarize.js           # 纯函数核（无 harness 依赖 ⇒ 仓库内可直接测）
    │   ├── client/index.ts        # 客户端半边（浏览器）：conversation.input.dock 状态条 + locale 字典
    │   └── tools.js               # agent 面向的两个只读工具（**剥掉答案**）
    ├── build/web-platform.ts      # 平台模块表（快照；**升级宿主前必须重取**）
    ├── tsdown.config.ts           # 客户端产物构建（镜像官方 clientConfig）
    ├── tools/build-client.mjs     # 构建壳（调用本机已有 tsdown，不联网）
    ├── lib/client.js              # ★ 构建产物（入仓；**改了 src/client 必须重跑 build**）
    └── tests/                     # `node --test`（假上游 + 假 loader + 真断言；28 条）
```

## 安装（本机 DSH）

> **开发环 vs 交付**：迭代时用 `dsh web --patch dsh/math-drill-plugin/cordis.patch.yml`（官方推荐的 overlay 方式，
> 不必先装进 profile，改完重启即可）；`dsh plugin add` 是**交付**动作。
> **任何插件改动都要重启 `dsh web` 才生效**——加载器图在进程启动时冻结。

```bash
# 1) 把插件的宿主依赖链到本机 DSH（必须；见下方"为什么必须"）
node /home/myuser/workspaces/DeepSeek/math-drill/dsh/math-drill-plugin/tools/link-dsh-deps.mjs

# 2) 把插件挂进 web profile（pnpm link 本地目录；reconcile 会自动写进 dsh.profile.bundles）
dsh plugin --profile web add /home/myuser/workspaces/DeepSeek/math-drill/dsh/math-drill-plugin

# 3) 只组合不启动，先看它有没有进树
dsh --profile web --dump-config | grep -A3 math-drill-dsh
```

**为什么必须有第 1 步**（2026-09-19 实测，不是推理）：以 `link:` 装的插件，Node 解析 `import` 时用的是包的
**真实路径**（仓库里的这个目录），父级一路向上都到不了 DSH 的依赖目录 ⇒ 缺 `@deepseek-ai/*` 时
**整个插件树拒绝加载、宿主启动失败**（不是"功能没开"）。生态里的同类插件靠**自带 `node_modules`**
解决（如 `@yuxianglin/dsh-bridge-browser`），本脚本照同一条路走，但**不联网**：直接链到本机 DSH
安装树里的同名包，版本必然等于宿主正在用的那份。

> 顺带一个实测：本机 `$DSH_HOME/profiles/node_modules`（"扁平回退目录"）**整目录悬空** ——
> 435 条断链指向已卸载的 AppImage 挂载点 `/tmp/.mount_…`。它**不是真源**，脚本因此从安装树取包。

## 凭据（**唯一的人工步骤**）

服务间凭据**不下发**，用规格 §3.3 的派生命令在服务器上算出来，落到本机 **0600** 文件：

```bash
# 在服务器上（systemd 注入 MATH_DRILL_TOKEN_FILE 的环境里）
cd /opt/math-drill && python3 -c "from bridge.api import load_config, load_token, agent_value; print(agent_value(load_token(load_config())))"
# 本机
mkdir -p ~/.dsh/math-drill && umask 077 && pbpaste > ~/.dsh/math-drill/agent-credential   # 或用编辑器粘贴
chmod 600 ~/.dsh/math-drill/agent-credential
```

也可以用 `MATH_DRILL_AGENT_CREDENTIAL` 环境变量注入（`cordis.patch.yml` 的 `credentialEnv`）。
**纪律**：凭据值不写入会话 / 文档 / 仓库；插件侧只读文件，**永不打印、永不进工具输出**。

## 与 ADR-015 的对应

| ADR-015 | 本目录的落点 |
|---|---|
| 决策 1 形态（宿主 + 插件、引擎用现成的） | 本目录只写**接线**，不写 agent 引擎 |
| 决策 3 桥接鉴权（Bearer + 按凭据分桶） | `src/credential.js` + `src/math-drill-api.js`（`Authorization: Bearer …`） |
| 决策 4 代码落点 | 本目录即 `dsh/` 顶层域 |
| 决策 5 红线（判定链路无 LLM / 不进判定路径 / 不直写库） | `src/math-drill-api.js` **只有 GET**；`src/tools.js` **剥掉答案与解析** |
| 决策 6 共享纪律（优先追加型槽位） | Phase B 的 UI 半边（见下） |

## 分期（与 ADR-015 决策 2 一致）

- **Phase A（已落地）**：宿主半边 —— 只读数据通路 + 两个 agent 工具（进度 / 今日题单）+ 只读状态路由。
- **Phase B（已落地，2026-09-19/20）**：客户端半边 —— `conversation.input.dock`（**追加位**）里的状态条；
  文案走 `math-drill` locale 命名空间（zh/en 键对齐），样式只用 `--dsw-alias-*` 语义 token。
  产物是 `window.__ModuleLoader__.load({id, factory})` 包装，由 `tsdown.config.ts` 构建（镜像官方 per-package 预设，
  去掉我们用不到的 CSS Modules 段）。
  ⚠️ **改了 `src/client/**` 必须重跑 `node tools/build-client.mjs`** —— 产物 `lib/client.js` 是入仓的、不会自己更新
  （本轮吃过一次：改了源码没重建，测试立刻红）。
- **明确不做的**（2026-09-20 评审定案）：`dsh.client.immediately: true`（那是基础设施行专用）；
  换槽位到 `conversation.composer.dock`（它带 `!hero` 守卫，会在"刚开新会话"时消失）。
- ⚠️ **两条"别按一致性顺手改"的取舍**（详见 `math-drill-plugin/README.md` 的"已知取舍"节）：
  ① `package.json` 的 `dsh.client.inject`（**包名边**，信息性）与 `src/client/index.ts` 的**运行期** `inject`
  **故意不一致** —— 前者留着 `@deepseek-ai/dsh-client-locale` 是"我们碰过 locale 包"的唯一记录，删了就没线索；
  ② `ctx.get('locale')` 是**一次性读取、不重试**：locale 晚到的宿主会**永久走中文回退**（面板照常出现，只是不跟随宿主语言）。
- **0 号步 d**（ADR-015 分期）：先在这台笔记本上把 DSH 用起来，看 agent 到底帮不帮得上学习；
  插件只提供数据与工具，判断留给使用体验。

## 已知限制（如实登记）

1. **只读**：起步期 agent 不接触数学服务的写面（ADR-015 代价 5）。写作答将来必须走判定端点，不得直写库。
2. **`/api/daily` 的响应里带 `answer`/`analysis`**（服务端为前端判分准备的）——插件的工具层**剥掉**它们再进模型上下文；
   `tests/plugin.test.mjs` 有一条断言盯着这件事（红线要有机械护栏）。
3. **部署态与仓库态会分叉**：本机装的插件读的是 `https://math.zhu2006.xyz`；服务器上的 bridge 目前仍是旧构建，
   Bearer 路径**随下次部署生效**。
4. **宿主版本下限靠声明**（`package.json` 的 `peerDependencies` + `engines`）：DSH 是 rc、上游日更，
   槽位/工具 API 都可能变；升级宿主后要重跑 `node --test`。
