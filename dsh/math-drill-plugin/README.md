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

## 还没做（Phase B）

**客户端半边（UI 槽位面板）**。它要的是 DSH 的浏览器构建产物格式
（`window.__ModuleLoader__.load({id, factory})`，只能 `require` 平台模块：`react`、`react-dom`、
`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots` 等），因此需要 `tsdown` 工具链
（照 `~/.dsh/skins/maid-atelier/build/tsdown.client.ts` 的预设）。**在那之前不要手写
`lib/client.js` 的包装**：那是把构建产物当源码维护，属于本项目的"两处真值"病。
