# 继承面边界表（BOUNDARY）

> 状态：设计冻结（规划期）· 对象：fork 自 `111wukong/kaoyan-math-tutor`（MIT）
> 数据来源：逐文件 `wc -l` 实测（2026-09-17），非估计
> 用途：**决定哪些继承、哪些改造、哪些隐藏、哪些删**——以及开源仓库里不该出现什么

---

## 0. 实测清单（真值，勿再凭记忆引用）

| 文件 | 行数 | Phase-1 裁定 | 理由 |
|---|---|---|---|
| `js/app.js` | 2947 | **改造** | 存储层（唯一 sink）+ 判定调用 + 同步桥接线；46 处 `save()` 匹配（**45 调用 + 1 定义**）全在此文件 |
| `js/data-questions.js` | 1549 | **替换** | 204 题（每考点恰好 3 题、零解答题）→ 改为 bundle 载入 + customQ 通道 |
| `css/style.css` | 1063 | 保留 | 含 5 处 `@media`（手机适配来源，不要重写） |
| `js/classroom.js` | 851 | **隐藏**（`enabled=false`） | 多智能体课堂（1 老师 + 3 独立 agent 学生）：学生的 agent 学习兴趣点，但属 MVP 七条需求之外的巨石 |
| `js/tools.js` | 625 | 保留（不接线） | agent 工具层；Phase 5 素材 |
| `js/cards.js` | 541 | 保留 | AI 卡片蒸馏；无 key 时自动降级 |
| `js/game.js` | 497 | 保留 | 游戏化直接服务「每日习惯存活」（N1 的命脉之一） |
| `js/llm.js` | 385 | 保留（**红线**） | 客户端直连模型；**key 永不进服务端/blob**，服务端不设代理 |
| `js/data-knowledge.js` | 370 | 保留 + **导出** | 68 考点树（43 `all` + 5 `m1` + 20 `m1/m3`）= 服务端 `kp` 表导入源 + 标注受控词表 |
| `js/agent.js` | 332 | 保留（不接线） | agent 工具注册层 |
| `js/engine.js` | 331 | **改造** | 内含 `Judge`（判定）→ 判定迁服务端；`norm()` 保留 |
| `js/sm2.js` | 50 | 保留（参考） | 教科书 SM-2 已校验正确；P2a 迁服务端后可能退役 |
| `index.html` | 68 | 改造 | 增加同步状态指示、隐藏 classroom 入口 |
| `tests/*`（11 个文件） | **2175** | 改制（见 §3） | 511 项断言中，对「状态+选题层」**零覆盖**（全打桩） |

**源码 = 9,609 行**（js 8,478 + html 68 + css 1,063）；**含测试 = 11,784 行**。
> ⚠️ 更正记录：此前文档写的「源码 10,653」是算术错误（10,653 = 总量 11,784 − 误算的测试行数 1,131）。真值如上，已在 `技术评审请求-致Claude.md` §G 同步更正。

---

## 1. 三个硬边界（判定过的接缝）

| 接缝 | 现状（实测） | 改造动作 | 风险 |
|---|---|---|---|
| **存储 sink** | `localStorage` **仅 3 处直接触点**（`getItem`/`setItem`/`removeItem`，全在 app.js）；45 个 `save()` 调用点全部汇入**单一函数** | `save()/load()` → `web/js/api.js`（去抖 blob 同步，ADR-002）；45 个调用点**不动** | 低。真正风险不在 IO 而在状态模型（见 ADR-004） |
| **判定** | `engine.js` 内 `Judge.checkBlank` 为**纯前端字符串/数值比对**，且 fail-open | 判定迁服务端 `core/judge.py`（JUDGE_CONTRACT v1）；前端只上传原始输入 | 中。前端须移除本地判定分支，避免「两处判定」 |
| **出网通道** | `app.js:1821` 客户端直连 `LLM.chat`（卡片蒸馏；绕过全部服务端 API） | 保留但**纳入威胁模型**（ARCHITECTURE §1）；token 门只管数据 API，不管这条线 | 中。密钥安全责任在客户端（用户自带 key，本机使用） |

---

## 2. 状态字段处置（`state` 单体 blob）

| 顶层字段 | 裁定 | 说明 |
|---|---|---|
| `cards` | 改造（P2a） | **混合键**：知识点卡按 `kid`、错题卡按 `card.id`（app.js:449 vs :454）→ P2a 迁为 `kp_state{kid}` + 错题卡独立段 |
| `attempts` | **退役出 blob**（ADR-007） | 服务端 `attempts` 表为唯一事实源；blob 仅保留 UI 快照（过渡期），P2a 起改读服务端视图 |
| `daily` / `checkins` / `game` / `settings` | 保留（blob 段，newer-wins） | settings 以服务端为真相源 |
| `customQ` | 保留 + 强化 | 外部题源导入通道（兼容基底 JSON 格式）→ 接生成器 bundle |
| `notes` / `cardDeck` | 保留 | |
| `classrooms` / `chats` | **隐藏**（随 classroom 模块） | 不删字段（避免迁移脚本复杂化），仅入口隐藏 |

---

## 3. 测试重整清单（Phase 1 收尾执行）

**问题**：现有 511 项断言对**最该改的层零覆盖**——`pickDailyQuiz` 在 tests/ 中**零命中**，`nodeStatus` 在 4 个测试文件里**全是桩**（test-agent / classroom / fallback / loop）；`test-browser` 输出 **0 项**却计入「全过」。

| 动作 | 内容 |
|---|---|
| ① 保绿 | 存储改造后先让**现有测试重新全绿**（不删测试换绿：逐一核对失败原因） |
| ② 补桩改真 | 4 处 `nodeStatus` 桩 + `correctRate` 桩 → 接真实现 |
| ③ 新增 | `tests/test_judge.py`（JUDGE_CONTRACT §5 全量）、`tests/test_api.py`、`tests/test_store.py` |
| ④ P2b 前置 | `tests/test_picker.py`（选题器六条性质，**先红后绿**）+ `tests/test_dep_rules.py`（六域依赖矩阵） |
| ⑤ 标注 | `test-browser` 0 项事实写入测试报告（不再计入「全过」的口径） |

---

## 4. 删除候选（**不在 Phase 1 做**，代价已评估）

| 候选 | 行数 | 为什么暂不删 | 何时处理 |
|---|---|---|---|
| `classroom.js` + 相关测试 | 851 + 310 | 删除会连带 69 项断言失效；且是学生的 agent 学习素材 | Phase 5 决断（保留代码 + 入口隐藏已足够） |
| `tools.js` / `agent.js` | 625 + 332 | Phase 5 可复用 | Phase 5 |
| `js/data-questions.js` 内旧题 | 1549 | 替换为 bundle 后即为死数据，但删除前需确认无引用面 | Phase 1 收尾 |

> **裁定原则**：本项目的生命期是 2-3 年，**「隐藏」优于「删除」**——删除是不可逆的，隐藏是可逆的（`enabled=false` 一行）。

---

## 5. 合规边界（开源仓库的红线）

| 项 | 裁定 |
|---|---|
| fork 出处 | `ATTRIBUTION` 声明上游 MIT + 仓库链接；保留上游 LICENSE |
| 我方新增代码 | MIT（与上游兼容）；**不得引入 GPL/AGPL 代码**（shiroha GPL-3.0 / xzs AGPL-3.0 只借思路不抄码） |
| **题目数据** | ⛔ **一切真题/书稿 OCR 数据不入库**——开源仓只含：我方生成器产物 + 用户自备 customQ 示例（合成样例） |
| LLM key | ⛔ 永不入仓（含示例配置、测试夹具、日志） |
| 上游题目的授权链 | 上游未声明 `data-questions.js` 的题目来源授权（MIT 只覆盖代码不覆盖数据）→ **故我方替换而非沿用其题库**（这也是替换 1549 行的合规理由，不只是质量问题） |

---

## 6. 未决项（待决策人拍板）

1. `classroom` 的处置：隐藏（当前默认）还是 Phase 1 即删（连带测试重整）
2. ~~`tests/` 现有 11 个文件是否按模块下线整改~~ **← 已由 D6 定案（v2.6）**：fork 的 node 测试**整体迁入 `web/tests/`**（`run-all.js` 按 `__dirname` 扫描，散放即断；见 ARCHITECTURE §11.9 / §13.2）
