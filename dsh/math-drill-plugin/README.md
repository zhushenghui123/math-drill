# `@math-drill/dsh-plugin` —— 桥接插件（宿主半边）

把考研数学练题系统的**只读**数据接到 DSH：两个 agent 工具，**不写任何东西**。

## 它做什么

| 工具 | 上游 | 给 agent 的 |
|---|---|---|
| `math_drill_progress` | `GET /api/state` | 轨道、目标考试与剩余天数、今日完成度、打卡、卡片/笔记数 |
| `math_drill_today` | `GET /api/daily` | 今天的题干、考点 `kid`、题型、难度、选项 |

**两条红线写进了代码，不是写在注释里**：

1. **答案不进上下文** —— `/api/daily` 的响应带 `answer`/`analysis`（服务端给前端判分用的），
   `src/summarize.js` 的 `stripQuestionAnswers` 在进模型前剥掉它们。
   agent 在**讲解侧**，不在答案侧（ADR-013 的定位 + ADR-015 决策 5）。
2. **只读** —— `src/math-drill-api.js` 只暴露两个 GET 方法，**没有写方法**；起步期 agent 不接触写面
   （ADR-015 代价 5）。将来"写作答"必须走判定端点（ADR-007 的 judge 独占写入），不得直写库。

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

```bash
node tools/build-client.mjs      # 构建产物；⚠️ 改了 src/client/** 必须重跑（产物入仓、不会自己更新）
node --test tests/               # 28 条：凭据纪律 / wire / 红线 / 接线 / 产物形状 / **产物运行时**
```

> ⚠️ **升级宿主 DSH 前**：`build/web-platform.ts` 的 `PLATFORM_MODULES` 是**快照不是契约**（ADR-015 代价 1）。
> 若新版把 `@deepseek-ai/dsh-client-ui-slots` / `dsh-client-locale` 移出表，客户端产物会**当场抛错、状态条整块不出现**。

## 还没做

- **C2 工具卡片**（`tool.call.toolview`，key = 工具名）：让 `math_drill_today` 的结果在对话里是卡片。
- **C3 设置页**（`settings.section`）：把 `baseUrl` / 凭据路径搬进设置界面。
- **C4 斜杠命令**（如 `/math`）：契约点在 `packages/extensions/ui-cordis/src/client/index.ts:168` 的 `slash.registerSource`。

三条都**要求先查契约再动手**（官方 Skill 的原话：不要从服务名/槽位名/示例反推 API）。
