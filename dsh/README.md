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
    │   ├── math-drill-api.js      # HTTP 客户端（四个读方法 + **两个写方法**：setDifficulty / writeNote，白名单可枚举）
    │   ├── summarize.js           # 纯函数核（无 harness 依赖 ⇒ 仓库内可直接测；含"答案不进上下文"的剥离函数）
    │   └── tools.js               # agent 面向的工具（三个只读 + 一个标难度 + 一个写复盘；**剥掉答案**）
    └── tests/                     # `node --test`（假上游 + 假 loader + 真断言；23 条）
```

> ⚠️ **2026-10-08 收敛（ADR-024）**：**客户端半边整体删除** —— 状态条、小组件面板、`tsdown` 构建链、
> 平台模块表、构建产物、两半共用的契约文件、以及只服务状态条的只读摘要路由，全部撤下。
> 理由（决策人原话）：**展示都在控制台里，插件重复一遍是多余的**；插件只保留"替 agent 打通数据通路"。
> 因此 `inject` 从 `['tools','webServer']` 收成 `['tools']`，`package.json` 去掉 `dsh.client` 与 lib 目录。
```

## 安装（本机 DSH）

### 在**干净的本地测试环境**里验证（推荐，2026-09-20 起）

不要拿装了十几个插件的日常 DSH 去验证我们自己的插件（"我们的问题"和"别人的问题"会混在一起）。
用这个脚本起一个**独立 DSH_HOME + 最小 profile**（只 `@deepseek-ai/dsh-base` + `dsh-web-app` + 我们的插件），
等价于把服务器上的**轻量新环境**搬到本机，**完全不碰你的 `~/.dsh`**：

```bash
bash dsh/tools/local-test-env.sh          # 建/刷新（幂等）：链接依赖 → 建 profile → 复制凭据(600) → 组合树自检
bash dsh/tools/local-test-env.sh start    # 后台启动（默认 http://127.0.0.1:39192，避开你日常的 39191）
bash dsh/tools/local-test-env.sh check    # 冒烟：首页 / boot roster / 客户端产物 / 状态路由
bash dsh/tools/local-test-env.sh stop     # 停掉
```

可用环境变量：`DSH_HOME`（默认 `~/dsh-math-test`）、`PORT`（默认 `39192`）、`CREDENTIAL`（默认从 `~/.dsh/math-drill/agent-credential` 复制）。
脚本里所有 `DSH_HOME` **必须 export** —— 踩过一次：只赋 shell 变量时 `dsh plugin add` 会跑到真实 `~/.dsh` 上，
于是"干净 profile"根本没建、而自检还在真 profile 上"通过"。

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
| 决策 5 红线（判定链路无 LLM / 不进判定路径 / 不直写库） | `src/tools.js` **剥掉答案与解析**；写面在 2026-09-21 被 **ADR-018 收窄成白名单** —— 见下一行 |
| **决策 5 的例外（ADR-018 / ADR-023）** | 写动作**只允许两个**：`setDifficulty`（标难度）· `writeNote`（写复盘/评分）⇒ `src/math-drill-api.js` 的 `WRITE_METHOD_NAMES = ['setDifficulty','writeNote']`，测试断言这个集合不许长大。**写作答仍不直写库**（走判定端点） |
| 决策 6 共享纪律（优先追加型槽位） | —— **已不适用**：客户端半边整体删除（ADR-024），插件不再注册任何槽位 |

## 分期（与 ADR-015 决策 2 一致）

- **Phase A（已落地）**：宿主半边 —— 只读数据通路 + 三个 agent 只读工具（进度 / 今日题单 / 复盘）+ 只读状态路由；
  **2026-09-21 追加一个写工具**：`math_drill_set_difficulty`（把 agent 判定的难度写回题库，控制台按它显示）。
- **Phase B（2026-09-19/20 落地 → **2026-10-08 删除**，ADR-024）**：曾经做过客户端半边
  （`conversation.input.dock` 的状态条 + `lib/client.js` 产物 + tsdown 构建链 + 平台模块表）。
  决策人拍板：**展示都在控制台里，插件重复一遍是多余的** ⇒ 整套撤下，插件只做数据面。
- **工具卡片（C2，已落地）**：`math_drill_progress` / `math_drill_today` 的结果在对话里是卡片
  （keyed `tool.call.toolview`，key = wire 工具名）。**注意 keyed 命中会替换通用行** —— 卡片必须自己渲染输出。
- **斜杠命令（C4，已落地）**：`/math`（进度）· `/math today`（今日题单）· 其它参数报用法。
  同样按"可选服务"处理：`ctx.get('commands')`，没有就只少一条命令，不拖住工具与路由。
- **已删除的展示面（不再有这些取舍）**：槽位选择、`immediately`、locale 回退时机、卡片 keyed 覆盖……
  这些都随客户端半边一起撤下了；将来若真要重做，按当时的宿主契约重新引入（不要恢复旧产物）。
- **0 号步 d**（ADR-015 分期）：先在这台笔记本上把 DSH 用起来，看 agent 到底帮不帮得上学习；
  插件只提供数据与工具，判断留给使用体验。

## 已知限制（如实登记）

1. **写面白名单**：ADR-018 起允许**一个**写动作 = 给题目标难度（`/m/qbank/set_difficulty`，只写 `agent_difficulty` 表）。
   **写作答仍不得直写库**（必须走判定端点，ADR-007）；**加第二个写动作必须先立 ADR**（ADR-018 代价 2/4）。
   ⚠️ 如实登记：在那之前本目录的卖点之一是"**结构性只读**（代码里根本没有写方法）"—— 那句话**从 ADR-018 起不再成立**，
   现在靠的是"**可枚举白名单**"+ 测试护栏，不是"不可能"。
2. **`/api/daily` 的响应里带 `answer`/`analysis`**（服务端为前端判分准备的）——插件的工具层**剥掉**它们再进模型上下文；
   `tests/plugin.test.mjs` 有一条断言盯着这件事（红线要有机械护栏）。
3. **部署态与仓库态会分叉**：本机装的插件读的是 `https://math.zhu2006.xyz`；服务器上的 bridge 目前仍是旧构建，
   Bearer 路径**随下次部署生效**。
4. **宿主版本下限靠声明**（`package.json` 的 `peerDependencies` + `engines`）：DSH 是 rc、上游日更，
   槽位/工具 API 都可能变；升级宿主后要重跑 `node --test`。
