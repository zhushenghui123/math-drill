# 施工交接单（IMPLEMENTATION BRIEF）· 交给 Codex

> 本文件是**给执行方（Codex）的施工指令**，不是设计讨论稿。
> 规划方（AI 导师）已冻结设计并交付六份设计文档；执行方按本单施工，**不需要重新做架构决策**。
> 施工前请先读 §1 的文档顺序（读完再动手），并严格遵守 §2 的硬约束。

---

## 0. 角色与权限边界

| 角色 | 谁 | 权限 |
|---|---|---|
| 决策人 | 学生本人 | 需求、优先级、开放决策（§6）的最终裁定 |
| 规划方 | AI 导师 | 设计冻结、验收标准定义、施工单编写；**不写实现代码** |
| 执行方 | **Codex** | 按本单实现、跑测试、产出证据；**遇 §5 情况必须停下回报，不得自行改设计** |
| 复核方 | 质检官（可选第三方评审） | 对施工产物做独立复核 |

**Codex 禁止自行决定的事**（属设计层）：
- 改动 `docs/` 下任何设计文档的**结论**（可以提 PR 建议，不可直接改）
- 引入任何第三方依赖（见 §2-H1）
- 改变 answer_type 集合、blob 合并规则、依赖矩阵、启停表语义
- 删改 fork 的 UI 结构（只允许最小接线，见 BOUNDARY §1）
- 在服务器上改动 `obsidian-livesync` 项目**已有内容**（只允许**追加**站点块）

---

## 0.5 文档命名约定（先读，避免找错文件）

- 设计文档**原名为** `ARCHITECTURE-v2.md`（版本号曾在文件名里）；**T0 已更名并搬入 `docs/ARCHITECTURE.md`**（2026-09-17 执行），此后版本号走 §9 变更记录，不再进文件名。
  **脚手架落地时（T0）把它复制/更名为 `docs/ARCHITECTURE.md`**，此后正文内的版本号走 §9 变更记录，不再进文件名。
- 其它文档名已稳定：`JUDGE_CONTRACT.md` / `BOUNDARY.md` / `DATA_PIPELINE.md` / `MODULE_TEMPLATE.md` / `DECISIONS.md` / 本单。
- 本文档中出现的 `README.md` / `THIRD_PARTY_NOTICES.md` / `ATTRIBUTION` 均指**待建**的仓库文件（见 T0），不是现有文件。

---

## 0.6 仓库落盘路径（复核确认项）

| 项 | 定案 |
|---|---|
| 仓库根 | **`/home/myuser/workspaces/DeepSeek/math-drill/`**（本地开发态） |
| 设计文档 | ✅ **已完成**（T0，2026-09-17）：7 份自 `linalg-drill/docs/` 迁入 `math-drill/docs/`，`ARCHITECTURE-v2.md` 已更名 `docs/ARCHITECTURE.md`；原位置不再保留副本（避免双真相源） |
| 存量原型 | `linalg-drill/drill/exact.py` + `linalg-drill/tests/test_exact.py` → **T0.5 迁入** `core/exact/` 与 `tests/` |
| 服务器部署态 | `/opt/math-drill`（代码）+ `/var/lib/math-drill`（数据）+ `/var/log/math-drill.log`（见 ARCHITECTURE §12） |
| 是否含 fork 的 `.git` | **不含**——作为独立仓库起步，上游以 `ATTRIBUTION` 声明 |
| 上游 pin | **`111wukong/kaoyan-math-tutor` @ `82c014479f712a88b43fc147ab92d824c0ccc784`（master, 2026-09-14）**——T5 的「511 项全绿」基线即该版本实测值（v2.7 补，回应复核 C-2） |

## 1. 施工前必读（按顺序，读完再动手）

| 序 | 文档 | 作用 |
|---|---|---|
| 1 | `docs/ARCHITECTURE.md`（**§11.9 真值树 + §12 部署规格 + §13 配置与凭据 + §14 refcheck**为准；§2/§10.B 为演进留档） | 骨架真值：目录、依赖矩阵、路由权威、装载豁免、部署、配置与凭据、文档护栏 |
| 2 | `docs/JUDGE_CONTRACT.md` | **Day-1 任务的全部规格**（不变量、类型表、决策树、验收测试） |
| 3 | `docs/BOUNDARY.md` | 继承面裁定：哪些文件改、哪些隐藏、哪些保留 |
| 4 | `docs/MODULE_TEMPLATE.md` | 加模块的七步 + 七道质量门（施工脚手架按此） |
| 5 | `docs/DATA_PIPELINE.md` | 数据管线（**Phase 3 才动手**，本单不含） |
| 6 | `docs/DECISIONS.md` | ADR-001~009：所有已定决策与**代价承认**（别推翻已定项而不写 ADR） |

---

## 2. 硬约束（违反即返工，不接受"先跑起来再说"）

| # | 约束 | 验收方式 |
|---|---|---|
| **H1** | 服务端**零第三方依赖**（纯 Python 3.12 stdlib）；数据管线可另建环境，但不在本单范围 | 对 `core/ modules/ generators/ scripts/ bridge/` 逐文件核对顶层 import（AST 扫描，`test_dep_rules.py` 覆盖同一逻辑）；⚠️ 原命令扫的 `server/` 在 v2.5 树中已不存在 |
| **H2** | **禁止 YAML**（全仓） | ①`grep -rn "yaml" --include=*.py core/ modules/ generators/ bridge/ scripts/` 零命中；②`find . -name "*.yaml" -o -name "*.yml"` 零结果（含配置与 CI 文件） |
| **H3** | 判定链路**无 LLM、无网络**；`parseFloat` 在判定器中零出现 | JUDGE_CONTRACT §5.4 的 grep 证据 |
| **H4** | 判定必须 **fail-closed**（判不了返回 `undecidable`，**绝不回退猜测**） | 回归集 10/10 + 边界集 6/6 + 性质测试 300 例零违反 |
| **H5** | blob 与 sqlite 的边界按 ADR-007：**attempts 由 judge 独占写入**，模块不建表 | `test_dep_rules.py` + 人工审查 |
| **H6** | 依赖方向单向（六域矩阵）；core **静态**不得 import 任何模块/bridge；**唯一豁免** = `core/registry.py` 的动态装载（规则见 ARCHITECTURE §11.4.1） | `tests/test_dep_rules.py` 绿（AST 扫描 + importlib 单点 + 清单对齐三项） |
| **H7** | **凭据零入仓**：任何 key/token/密码不得出现在代码、配置、测试夹具、日志、README | 精确模式扫描 `sk-[A-Za-z0-9]{16,}`、`(api[_-]?key|secret|password)\s*[:=]\s*["\x27][^"\x27]{8,}`、`Bearer [A-Za-z0-9._-]{20,}`（⚠️ 原 `git grep token` 会命中大量合法词，不可用）；**再加一次人工过目提交 diff** |
| **H8** | **版权数据零入仓**：真题/书稿 OCR 内容一律不进仓库（含测试样本） | 同上人工确认 |
| **H9** | 不得引入 GPL/AGPL 代码（只可借鉴思路，不可抄码） | 许可证审查：新增文件均 MIT |
| **H10** | fork 上游测试基线：改造后**先恢复到 511 项全绿**，再动新功能（允许修桩，不允许删测试换绿） | `node web/tests/run-all.js` 输出留证（路径见 D6 / §11.9） |

---

## 3. 任务序列（Phase 1 施工单）

**「不造轮子」总则（v2.10 补，回应决策人指示）**：① **服务器运行时零依赖不变**（H1 / ADR-005）——这是"2 年不腐烂"的既有决策；② **开发/工具面可以用现成工具**（如 `refcheck.py` 允许调用系统已有的通用命令；本地不必为此装运行期依赖）；③ **前端沿用 fork 既有栈**（KaTeX 与现成 js，不重写 UI）；④ **算法不复创**：SM-2 直接用基底已校验实现（ADR-004）、判等用 stdlib `fractions`、精确算术用既有 `exact.py`；⑤ 凡确需自写之处（HTTP 面、装载器、refcheck），**在该任务证据里留一行「现成方案为何不适用」**——把"是否造轮子"变成可审计的判断，而不是默认手写。

### T0 · 环境与仓库就位
- **产出**：工作副本 + 目录骨架（按 ARCHITECTURE §11.9 真值树），每个文件仅含一行职责注释；同时建立 **README.md 骨架**、**ATTRIBUTION**（上游 MIT 出处声明）、**THIRD_PARTY_NOTICES.md**、**.gitignore**（排除 `data/`、`references/`、`*.db`、`*.db-wal`）；另交付 **`scripts/refcheck.py`**（文档自洽护栏，规格见 ARCHITECTURE §14，**必须含三类负例自测**——能绿的 checker 才算交付）
- **非占位例外**（v2.8 补，v2.9 修订）：`contracts/blob_merge.md` 与 `contracts/events.py` **不是空壳**——T0 即须把 §3.5 的合并表**原样搬入**前者、把事件枚举骨架+命名规则落进后者（首个事件由使用它的模块同 commit 追加）；`tests/test_dep_rules.py` 是 **T0 实产**（AST 扫桩即能绿，H6 的验收就靠它）；`tests/test_registry.py` 则**不是 T0 实产**——被测对象 `core/registry.py` 属 T3，故 T0 只建骨架，标 **[T3]**（v2.9 修正：原先把两者并列会造成"越界 / 空壳 / 红"三解）
- **文档就位**：把六份设计文档纳入 `docs/`，并把 `ARCHITECTURE-v2.md` 更名为 `docs/ARCHITECTURE.md`（见 §0.5）
- **验收**：目录树与 **§11.9** 一致；`git status` 干净；`docs/` 六份文档已纳入仓库（作为施工依据留存）
- **证据**：`tree -L 3` 输出 + `git log --oneline -1`
- **注意**：仓库里**不得**包含 fork 的 `.git`（作为独立仓库起步，上游以 ATTRIBUTION 声明）

### T0.5 · 存量资产迁移（回应复核 M7：唯一存量此前无归属）
- **规格**：ARCHITECTURE §11.9（`core/exact/`）+ ADR-006 追记 P1
- **产出**：原型 `linalg-drill/drill/exact.py` → `core/exact/exact.py`；`linalg-drill/tests/test_exact.py` → `tests/test_exact.py`
- **约束**：**算法零改动**（这是已验证资产：454 行 / 30 项断言），只改 import 路径与包名
- **验收（双解释器门）**：`python3.12 tests/test_exact.py` 与 `python3.14 tests/test_exact.py` 均 **30 项断言全绿**
- **证据**：两次运行输出 + `git log --stat` 显示为纯移动
- **注意**：若原型与新树有命名冲突，以 §11.9 为准（新树优先）

### T1 · 判定器（Day-1，最高优先）
- **规格**：`docs/JUDGE_CONTRACT.md` 全文
- **产出**：`core/judge.py` + `tests/test_judge.py` + `contracts/answer_types.py`
- **顺序（TDD，不可反）**：
  1. 先写回归集 10 例 + 边界集 6 例 + 性质测试 3 条 → **跑出红**
  2. 实现判定器 → **跑出绿**
  3. 补 `answer_types.py` 枚举 + 契约一致性测试
- **验收命令**：`python3 -m unittest tests.test_judge -v`
- **必须留证**：修复前的失败输出（红）+ 修复后的通过输出（绿）；`grep -n "parseFloat" core/judge.py` 为空
- **停止条件**：若某例无法在 fail-closed 前提下通过 → 停下回报（不得放宽为容差匹配）

### T2 · 存储层与 blob 同步
- **规格**：ADR-002 + ARCHITECTURE §3.5 合并规则
- **产出**：`core/store.py`（sqlite3 WAL + blob 读写 + `base_version` 仲裁）+ `tests/test_store.py`
- **验收**：并发/冲突用例（version 不匹配 → 409 + 返回最新 blob）；重启后数据不丢
- **证据**：单测输出 + 一次手工双设备模拟记录

### T3 · bridge 与路由权威
- **规格**：ARCHITECTURE §11.5
- **产出**：`bridge/api.py`（**唯一 HTTP 面 + 进程入口**）+ `core/registry.py`（装载器，被 bridge 调用；⚠️ 原写 `core/server.py` 已于 ADR-010 删除，不得创建）+ `tests/test_api.py`
- **规格补充**：token 门与 `/setup?t=` 下发、静态根与 403 规则、`config/server.toml` 读取——**全部见 ARCHITECTURE §13**
- **验收**：`/api/{state,judge,daily}` 可用；`/m/<module>/<rpc>` 由 bridge 统一挂载；**除引导端点 `/setup` 外**，全部路由过统一 token 门 + rate-limit；静态面匿名只读、越权路径一律 403（`/setup` 是唯一例外——它就是换取凭证的入口。见 ARCHITECTURE §11.5 / §13.2 / §13.3。原写「无例外面」为漏改，v2.8 修正）；**限速可测**：循环请求 `/api/state` 超过 `api_per_minute` → 429（v2.8 补清单⑥）
- **证据**：`test_api.py` 全绿 + 一条「无 token 请求被拒」的实测输出

### T4 · 前端接线（fork 改造，最小面）
- **规格**：BOUNDARY §1（三处硬接缝）
- **产出**：`web/js/api.js`（唯一存储桥）+ `web/js/engine.js` 判定调用改走 `/api/judge` + **`web/index.html`** 加同步状态与 classroom 入口隐藏（静态根与暴露面规则见 ARCHITECTURE §13.2）
- **约束**：**45 个 `save()` 调用点不动**；`localStorage` 三处触点收敛到 api.js；不得重写 UI
- **验收**：T5 恢复后的 fork 测试全绿；手工点击「做一题」→ 服务端日志出现 `/api/judge` 记录

### T5 · 继承测试基线恢复
- **规格**：BOUNDARY §3 五步
- **产出**：`node web/tests/run-all.js` 恢复到 **511 项全绿**（桩按实况修正，不删测试）
- **证据**：改动前后两次输出对照

### T6 · 题源接线（生成器 → 题库）
- **规格**：ARCHITECTURE §10.D + MODULE_TEMPLATE §4
- **产出**：`generators/linalg_det/` + `scripts/gen_bundles.py`（扫描 generators/ → `data/bundle-v1.json`）+ **灌库脚本就具名为 `scripts/db_init.py --load-bundle data/bundle-v1.json`**（v2.8 补清单③：原先只写"灌库脚本"，无名无验收）
- **验收**：**线代 Ch1（行列式）≥40 题**可生成（Phase 1 只做 Ch1，Ch2+ 见 §6/M6）；**同 seed 同输出**（可复现门）；每题带 `gen_params` 与 `kid`；**落库可查**：灌库后 `sqlite3` 查 `questions` 表 ≥40 行（这条是 T7 ④⑤ 的可达前提）
- **证据**：两次生成同一 seed 的 diff 为空；抽样 5 题人工核算答案

### T7 · 部署（**需决策人在场**）
- **规格**：ARCHITECTURE **§12 部署规格 + §13 配置与凭据**（systemd 字段表 / Caddy 站点块 / 备份自检 / 验收**十二项**；token 生成、下发与轮换见 §13.3，引导端点 `/setup` 不过 token 门）
- **产出**：`deploy/math-drill.service`（专用用户 + `NoNewPrivileges` + `PrivateTmp`）+ `deploy/caddy.block`（**追加**到 `/root/obsidian-livesync/Caddyfile`）+ `deploy/backup.timer`
- **部署前置**（v2.8 补清单③）：先跑 `scripts/db_init.py`（建表 + `schema_version` + 灌 bundle），否则 T7 ④⑤ 依赖的 `questions`/`attempts` 两表不可达
- **约束**：
  - 服务只绑 `127.0.0.1:8081`，**绝不绑 0.0.0.0**
  - Caddy 配置只**追加**站点块，改前先备份（该目录是 git 化的，改动可回滚）
  - **不得**触碰服务器上其它服务（CouchDB / dsh-web）
  - DNS：`math.zhu2006.xyz` A 记录由**决策人**在 Cloudflare 手动添加（DNS only）
  - SSH 凭据由决策人现场提供，**不得写入任何文件**
- **部署前置（§13.3）**：`openssl rand -hex 32 > /etc/math-drill/token` + `chmod 600` + 属主 `math-drill`；systemd 注入 `MATH_DRILL_TOKEN_FILE`；**不落任何文件副本**
- **验收**：手机浏览器打开站点 → 走 `/setup?t=` 下发 cookie → 做完 2 题 → 服务端 attempts 出现 2 行 → 重启服务后数据仍在
- **证据**：截图或 curl 输出 + `systemctl status` 输出

### T8 · Phase 1 验收门（**不达标不进 Phase 2**）
```
① 双设备 blob 同步互通（手工验证记录）
② 判定 10/10 + 边界 6/6 + 性质 300 例零违反
③ **线代 Ch1（行列式）≥40 题**可生成且可复现
④ systemd 重启自恢复
⑤ 【硬门槛】决策人连续 7 天 × 每天 2 题真实使用
```
**⑤ 是产品门槛不是技术门槛**——它的意义是：习惯不活，后面所有工程量都是白做。

---

## 4. 提交规范（每个任务一个提交）

```
<task-id> <动词> <对象>
T1 judge: fail-closed 判定器 + 回归/边界/性质测试

正文须含：
- 验收命令与结果（贴输出）
- 证据文件路径（测试输出留档）
- 若偏离设计：说明理由 + 建议的新 ADR（不得默默偏离）
```

---

## 5. 必须停下回报的情况（不得自行处置）

| 情况 | 处置 |
|---|---|
| 某条验收标准无法在硬约束内达成 | 停下，回报，附最小复现；**不得放宽约束** |
| 发现设计文档自相矛盾 | 停下，指出矛盾点与两处原文（规划方会修订并更新 ADR） |
| fork 上游与文档描述不符（文件/行号/行为） | 停下，附实测证据（文档以实测为准更新） |
| 需要新增依赖 | 停下，说明为何 stdlib 不可行（需决策人批准并写 ADR） |
| 涉及服务器上其它服务 | 停下，回报（本单只允许追加站点块） |
| 需要凭据 | 停下，向决策人索取**当次会话内**使用，不得落盘 |

---

## 6. 交接时的开放决策（决策人确认后写入 ADR）

| # | 决策 | 当前默认 | 影响 |
|---|---|---|---|
| D1 | 项目名（`math-drill` 为工作名） | math-drill | 仓库名、服务名、域名子域 |
| D3 | `classroom` 处置 | Phase 1 隐藏入口（`enabled=false`），代码保留 | 影响 T5 测试重整范围 |
| D4 | 认证方案 | 长效 token cookie（HttpOnly+Secure+SameSite=Strict） | 影响 T3/T7；CF Access 为后续可选项 |
| D5 | τ（衰减常数） | 10 天 | Phase 2b 才生效，可后调 |
| **D6** | fork 的 node 测试落点 | **`web/tests/`**（整目录搬迁；`run-all.js` 用 `__dirname` 扫描 `test-*.js`，散放会直接断） | 影响 T5 验收命令路径与 H10 |

已定不必再议：`integer` 并入 `rational`（ADR-003 侧）、blob 方案 A（ADR-002）、零依赖（ADR-005）、
模块化组织（ADR-006）、kp_state 为 blob 段 + attempts 退役出 blob（ADR-007）。

---

## 7. 交付物清单（Phase 1 完成的定义）

```
✅ core/ + modules/ + generators/ + bridge/ + contracts/ 骨架落地（符合 §11.9 真值树）
✅ T1-T6 全部验收通过，证据留档
✅ deploy/ 三个文件就位，服务在 127.0.0.1:8081 运行，Caddy 反代生效
✅ fork 测试基线 511 全绿（或明确说明桩修正后的新基线）
✅ 判定链路 grep 证据（无 LLM/网络/parseFloat）
✅ 一次真实的「手机 → 做题 2 道 → 服务端留痕 → 重启不丢」记录
✅ 决策人签署 Phase 1 验收门（尤其 7 天使用门槛）
```

**上述齐备后，Phase 2a（粒度与记忆状态）才可启动。**
