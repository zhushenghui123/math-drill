# `@math-drill/dsh-plugin` —— 考研数学 × DSH 桥接插件（宿主半边 + 客户端半边）

把考研数学练题系统接到 DSH：**宿主半边**给 agent 三个**只读**工具 + **一个写工具**（标难度，ADR-018）+ 一条只读状态路由；
**客户端半边**在对话输入区上方放一条状态条。**不写作答**（判定链路无 LLM，agent 在讲解侧），**唯一会改服务端状态的动作是给题目标难度**。

## 它做什么

| 工具 | 上游 | 给 agent 的 |
|---|---|---|
| `math_drill_progress` | `GET /api/state` | 轨道、目标考试与剩余天数、今日完成度、打卡、卡片/笔记数 |
| `math_drill_today` | `GET /api/daily` | **只回数据**：题数、考点分布、难度分布、题型分布、题号（**不回题面/答案** —— 题在看板看） |
| `math_drill_review` | `GET /api/attempts` + `/api/kp` | 对错与正确率、**最该复习的考点**（kid 翻人话）、最近错题（日期+考点+题号） |
| `math_drill_set_difficulty` ⚠️**唯一的写** | `POST /m/qbank/set_difficulty` | 把**你判定的难度**写回题库（1-4 + 一句理由）；控制台随后按它显示，题库原生值保留 |

**两条红线写进了代码，不是写在注释里**：

1. **答案不进上下文** —— `/api/daily` 的响应带 `answer`/`analysis`（服务端给前端判分用的），
   `src/summarize.js` 的 `stripQuestionAnswers` 在进模型前剥掉它们。
   agent 在**讲解侧**，不在答案侧（ADR-013 的定位 + ADR-015 决策 5）。
2. **写面白名单** —— `src/math-drill-api.js` 暴露若干 GET 方法 + **一个** POST（`setDifficulty`，ADR-018）；
   写方法集合由 `WRITE_METHOD_NAMES` 声明、测试盯着它不许长大。
   ⚠️ **如实登记**：在这之前本插件的卖点是"**结构性只读**"（代码里根本没有写方法）——
   那句话从 ADR-018 起**不再成立**，现在靠的是可枚举白名单 + 测试护栏。**写作答仍不得直写库**（必须走判定端点，ADR-007）。

## 装

```bash
dsh plugin --profile web add /home/myuser/workspaces/DeepSeek/math-drill/dsh/math-drill-plugin
dsh --profile web --dump-config | grep -A3 math-drill-dsh   # 只组合不启动，先看进没进树
```

`dsh plugin` 是 pnpm 的转发器：装完它按 `package.json` 的 `dsh.bundle.patch` 声明把本包
reconcile 进 profile 的 `dsh.profile.bundles`（**不需要手改 profile 文件**）。

## 配凭据

服务间凭据**不从服务端下发**，在服务器上离线派生（Bearer 规格 §3.3）：

```bash
# 服务器（在 systemd 注入 MATH_DRILL_TOKEN_FILE 的环境里）
cd /opt/math-drill && python3 -c \
  "from bridge.api import load_config, load_token, agent_value; print(agent_value(load_token(load_config())))"
```

把结果落到本机 **0600** 文件 —— 默认落点 `~/.dsh/math-drill/agent-credential`：

```bash
mkdir -p ~/.dsh/math-drill && chmod 700 ~/.dsh/math-drill
install -m 600 /dev/stdin ~/.dsh/math-drill/agent-credential   # 粘贴派生值后回车、Ctrl-D
```

也可用环境变量 `MATH_DRILL_AGENT_CREDENTIAL`（优先级高于文件）。
**插件会拒绝权限过宽的文件**（0644 ⇒ 直接报错，不读值）。

## 测

```bash
node --test /home/myuser/workspaces/DeepSeek/math-drill/dsh/math-drill-plugin/tests/
```

零第三方依赖：假上游用 `node:http`，断言覆盖凭据纪律、wire 行为、以及**答案不进输出**这条红线。
（带 `@deepseek-ai/*` 导入的接线层 `src/index.js`、`src/tools.js` 只能在装进 profile 后跑 ——
纯函数核与凭据/客户端在仓库内即可验证。）

## 配置项（`cordis.patch.yml`）

| 键 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `https://math.zhu2006.xyz` | math-drill 服务根 |
| `credentialPath` | `$DSH_HOME/math-drill/agent-credential` | 0600 凭据文件 |
| `credentialEnv` | `MATH_DRILL_AGENT_CREDENTIAL` | 环境变量覆盖位 |
| `timeoutMs` | `10000` | 单次请求预算 |

## 客户端半边（Phase B，**已落地** 2026-09-19/20）

`src/client/index.ts` 往 **追加型**槽位 `conversation.input.dock` 注册一条状态条（`list` 型，不碰 `single`）。
数据经**宿主半边**的只读路由 `/math-drill/summary`（`STATE_PATH`）取 —— **服务间凭据不进浏览器**，
浏览器只拿到已剥掉答案的文本。

| 关注点 | 落点 |
|---|---|
| 两半共用的路径/版本/形状判定 | `src/shared/contract.js`（相对 import ⇒ 被 tsdown **内联**，不落 `require` 表） |
| 文案 | `math-drill` locale 命名空间（zh/en **键对齐**，有测试）；`locale` 是**可选**服务（`ctx.get('locale')`），缺失时回退同一份字典而非静默不激活 |
| 样式 | 只用 `--dsw-alias-*` 语义 token（`--dsw-alias-border-l2` 0.5px 发丝线 + `--dsw-alias-brand-primary`）；**不**用 `--dsw-elevation-*`（本机 0.1.1-rc.1 全树零命中） |
| 产物 | `lib/client.js` = `window.__ModuleLoader__.load({id, factory})` 包装，`require` 只落平台表（`build/web-platform.ts`） |
| 工具卡片 | keyed `tool.call.toolview`（key = **wire 工具名**）—— 见下 |
| 渲染 | 正文走官方 **`MarkdownText`**（`@deepseek-ai/dsh-client-ui-primitives`，**平台表内**，内置 KaTeX）⇒ 题面公式渲染成真公式 |
| 组件 | 状态条标签与卡片状态用官方 **`Pill`**；卡片外壳用官方 **`DisclosureRow`**（受控折叠，默认展开）—— 全是平台表内模块 |
| 形态 | 状态条**一行式**（`⚡ 今日 0/7 · 🎯 还有 N 天 · 🔥 N 分钟`），明细留给 `/math` 与卡片；契约字段 `brief`（`STATE_SCHEMA_VERSION: 2`） |

### 公式与排版（2026-09-20 夜，回应"公式没渲染 / 不好看"）

1. **渲染件用官方的**：`ui-primitives` 的 `MarkdownText({ text })` —— 该包**本来就在 `build/web-platform.ts` 的平台表里**，
   其 CSS 也随宿主加载 ⇒ **零新依赖、零新机制**；markdown 排版 + KaTeX 公式，卡片与状态条共用。
2. **题面里的裸 LaTeX 包成 `$$…$$`**：题库题面是中文与数学式混排，`\begin{vmatrix}…\end{vmatrix}`
   **没有定界符** ⇒ markdown 不当数学渲染，用户看到一串反斜杠。宿主侧 `summarize.js` 的 `toMarkdownMath()`
   把数学环境包起来（有单测 + 端到端测试）。
3. **卡片正文不按行截断**：题面含 LaTeX，按行截会截出半个矩阵。

### 工具卡片（C2，2026-09-20 落地）

`math_drill_progress` / `math_drill_today` 的结果在对话里是**卡片**而不是裸文本：
`src/client/MathDrillCard.ts` 自己把输出画出来（标题 + 状态记号 ⏳/✓/⚠️ + 输出正文，超过 12 行折叠）。

⚠️ **为什么必须自己画**：官方源码写明 **keyed 命中会"替换"通用行**
（`packages/client/ui-tool/src/client/tool/models/tool-call-model.ts:29-36`：`…a keyed hit REPLACES the generic row`）
⇒ 注册了 key 却不渲染内容 = 用户看不到工具结果。数据面契约（`ToolCallOwnerProps` 的
`block`，`'kind' in block` 判落定、落定带 `content`/`isError`）也逐字核过，出处写在 `MathDrillCard.ts` 文件头。

### 两条**已知取舍**（别按"一致性"顺手改掉）

1. ⚠️ **`dsh.client.inject` 与运行期 `inject` 故意不一致，不要去"对齐"它**：
   `package.json` 的 `dsh.client.inject` 是**包名边**（信息性，服务预检显示与 HMR diff 用；
   定义见 `packages/client/modules/src/client/manifest.ts:58`），我们填
   `["@deepseek-ai/dsh-client-ui-slots","@deepseek-ai/dsh-client-locale"]`；
   而 `src/client/index.ts` 的运行期 `inject` 只有 `['slots']`（locale 是**可选**服务，走 `ctx.get`）。
   **删掉那个 locale 包边会抹掉"我们确实碰过 locale 包"的唯一记录** —— 下次想找谁在用 locale 时就没有线索了。
2. ⚠️ **locale 晚到的失败模式（已知、未修；2026-09-20 已真机测严重度）**：`ctx.get('locale')` 是**一次性读取、不重试**。
  若某个宿主先激活我们的插件、后提供 locale 服务，则本次进程内**永久走中文回退字典**
   （面板照常出现，只是不跟随宿主语言）。竞态依据：官方 Skill 的 "Access Services" 段（声明 `inject` 才会等它重新激活）。
  官方第三条路 `ctx.inject(deps, cb)`（≡ 挂一个带 `inject` 的子插件）能等到 locale 再回调，
  但**把槽位注册挪进回调会退回"面板可能永不出现"**，比现在更糟 ⇒ **当前实现是局部最优**，
  登记在此、不在 N=1（中文用户）场景下引复杂度。**若将来要支持英文宿主，这是第一个要改的地方。**

   **真机实测（2026-09-20，`dsh web --no-open --port 37795`）**：页面里的 boot roster 共 48 条，
  `@deepseek-ai/dsh-client-locale` 在**第 10 位**、`@math-drill/dsh-plugin` 在**第 46 位**，
  **且 locale 那一行带 `immediately: true`**（stage-one 预取）⇒ 我们的半边几乎不可能先于 locale 激活，
  该竞态在本机拓扑下**实际不会发生**（记录备将来换宿主/改组合时复查）。

```bash
node tools/build-client.mjs      # 构建产物；⚠️ 改了 src/client/** 必须重跑（产物入仓、不会自己更新）
node --test tests/               # 28 条：凭据纪律 / wire / 红线 / 接线 / 产物形状 / **产物运行时**
```

> ⚠️ **升级宿主 DSH 前**：`build/web-platform.ts` 的 `PLATFORM_MODULES` 是**快照不是契约**（ADR-015 代价 1）。
> 若新版把 `@deepseek-ai/dsh-client-ui-slots` / `dsh-client-locale` 移出表，客户端产物会**当场抛错、状态条整块不出现**。

### `/math` 斜杠命令（C4，2026-09-20 落地）

| 用法 | 结果 |
|---|---|
| `/math` 或 `/math progress` | 回一段**进度**（轨道 / 剩余天数 / 今日完成度 / 打卡 / 卡片数） |
| `/math today` | 回**今日题单**（题干、考点、难度、选项；**答案与解析不在内**） |
| 其它参数 | `{kind:'error'}` + 用法提示 |

契约（本机 0.1.1-rc.1 逐字核过）：`ctx.commands.register({ name, description, input:{hint}, handler })`，
handler 收 `CommandInvocation{ commandId, agent, rawInput, attachments, signal }`、返回
`{kind:'success', text?}` / `{kind:'error', text}`（`packages/interaction/commands/src/index.ts:34-48`、
`…/types.ts:27-34`）。
⚠️ **`commands` 走 `ctx.get`，不写成 `inject`** —— 与 locale 同一条教训：硬 inject 会在缺该服务的宿主上
把**工具与路由一起拖住**（静默不激活）；现在没有它只是少一条命令（有测试盯着这条路径）。

## 还没做

- **写回控制台**（决策人 2026-09-20 定的方向：agent 交流产生的数据要能写回研数）——**需要服务端新增读写面**：
  attempts 按 ADR-007 由 judge 独占写入，且当前**没有 attempts 读端点**（复盘/错因数据读不到）⇒ 这是 bridge/core 侧的改动，
  不在插件内；插件侧只需在拿到端点后加工具。
- **实时互通**：现在是"挂载时拉一次 + 手动刷新"；若要"实时"，得在 bridge 侧加推送（SSE/轮询契约），同时定清"谁在写、谁的版本赢"。
- **C3 设置页**（`settings.section`）：把 `baseUrl` / 凭据路径搬进设置界面。
- （原 C4 已落地，见上。）
- 任何后续项都**要求先查契约再动手**（官方 Skill 原话：不要从服务名 / 槽位名 / 示例反推 API）。
