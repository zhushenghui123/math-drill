# `@math-drill/dsh-plugin` —— 考研数学 × DSH 桥接插件（**只做数据面**）

把考研数学练题系统接到 DSH：给 agent **三个只读工具**（进度 / 今日题单 / 复盘）+ **两个写工具**
（`setDifficulty` 标难度，ADR-018 · `writeNote` 写复盘/评分，ADR-023）+ `/math` 斜杠命令。
**不写作答**（判定链路无 LLM，agent 在讲解侧）。

> ⚠️ **2026-10-08 收敛（ADR-024）**：**客户端半边已整体删除**（状态条、小组件面板、tsdown 构建链、
> 平台模块表、构建产物、只读摘要路由、两半共用契约）。决策人拍板：**展示都在控制台里，插件重复一遍是多余的**。

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

## 客户端半边（**2026-10-08 已删除**，ADR-024）

曾经做过：`conversation.input.dock` 的状态条 + 小组件面板（走宿主只读路由 `/math-drill/summary`，
浏览器只拿剥过答案的文本）。决策人拍板删除 —— **展示都在控制台里，插件重复一遍是多余的**；
插件现在的职责只有一条：**替 agent 打通与控制台的数据通路**。

## 还没做

- **写回控制台**（决策人 2026-09-20 定的方向：agent 交流产生的数据要能写回研数）——**需要服务端新增读写面**：
  attempts 按 ADR-007 由 judge 独占写入，且当前**没有 attempts 读端点**（复盘/错因数据读不到）⇒ 这是 bridge/core 侧的改动，
  不在插件内；插件侧只需在拿到端点后加工具。
- **实时互通**：现在是"挂载时拉一次 + 手动刷新"；若要"实时"，得在 bridge 侧加推送（SSE/轮询契约），同时定清"谁在写、谁的版本赢"。
- **C3 设置页**（`settings.section`）：把 `baseUrl` / 凭据路径搬进设置界面。
- （原 C4 已落地，见上。）
- 任何后续项都**要求先查契约再动手**（官方 Skill 原话：不要从服务名 / 槽位名 / 示例反推 API）。
