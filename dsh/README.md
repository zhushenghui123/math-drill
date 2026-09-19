# `dsh/` —— 考研数学 × DeepSeek Harness（ADR-015 的代码落点）

**这里是什么**：`docs/DECISIONS.md` 的 **ADR-015** 定的顶层域。形态是「**以 DSH 为宿主，考研数学做插件**」，
本目录放**插件侧**的全部代码；math-drill 的 Python 服务（判定 / 存储 / 题库）**一行不动**——它是判定与数据的
唯一权威，agent 只在**讲解侧**。

## 目录

```
dsh/
├── README.md                      # 本文件
└── math-drill-plugin/             # 桥接插件（宿主半边，Phase A）
    ├── package.json               # dsh.bundle.patch 声明 ⇒ `dsh plugin add` 会自动挂进 profile 的 bundles
    ├── cordis.patch.yml           # bundle 补丁：往组合树里 insert 一行（含 config）
    ├── README.md                  # 安装 / 配置 / 凭据 / 工具面
    ├── src/
    │   ├── index.js               # cordis 插件：name / inject / Config / apply
    │   ├── credential.js          # 服务间凭据读取（0600 校验；**永不打印**）
    │   ├── math-drill-api.js      # math-drill HTTP 客户端（**只读**：GET /api/state、/api/daily）
    │   └── tools.js               # agent 面向的两个只读工具（**剥掉答案**）
    └── tests/plugin.test.mjs      # `node --test`（零第三方依赖：假上游 + 真断言）
```

## 安装（本机 DSH）

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

- **Phase A（已落地）**：宿主半边 —— 只读数据通路 + 两个 agent 工具（进度 / 今日题单）。
  不需要浏览器构建工具链，装完即用。
- **Phase B（未开工）**：客户端半边（UI 槽位面板）。**它需要 DSH 的浏览器构建产物格式**
  （`window.__ModuleLoader__.load({id, factory})`，只允许 `react` / `react-dom` / `@deepseek-ai/cordis` /
  `@deepseek-ai/dsh-client-ui-slots` 等平台模块），因此要先把 `tsdown` 工具链装进本插件的 devDependencies
  （参考 `~/.dsh/skins/maid-atelier/build/tsdown.client.ts` 的预设）。
  **在 Phase B 之前不要手写 `lib/client.js` 的包装**——那是把构建产物当源码维护，正是本项目的"两处真值"病。
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
