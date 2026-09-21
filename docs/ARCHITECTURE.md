# 架构设计 v2（骨架冻结稿）

> 项目：`math-drill`（工作名）· 考研数学自适应练题系统
> 状态：**v2 冻结** —— 外部评审（Claude, GO WITH CHANGES）五条修改已全部采纳；本文是后续实现的唯一架构依据
> 性质：纯设计文档，无实现代码。字段表与签名是契约，不是可执行物
> 变更规则：此后任何架构级改动必须以 ADR 形式附记在 `docs/DECISIONS.md`，禁止无声变更

---

## 0. 已定案的四条架构决策（ADR 摘要，完整版见 docs/DECISIONS.md）

| ADR | 决策 | 裁判 |
|---|---|---|
| 001 | **基底 = fork kaoyan-math-tutor**（MIT），不选 gre2tor/OATutor/重构 | 外部评审：★0 不构成否决项；真正风险是继承面（已列边界表） |
| 002 | **存储同步 = 方案 A blob 同步**，废弃原子端点设计 | 评审定案；N=1 把 N=1000 的问题解掉属过度设计 |
| 003 | **判定 = 类型驱动 + fail-closed**；判分永在服务端；LLM 永不进判定链路 | 双方一致；MVP 不引 sympy |
| 004 | **调度起点 = SM-2 迁移版；FSRS 是 Phase 4 选项** | 一阶决策是粒度（KP 极）非算法；数据量不足喂不饱 FSRS optimizer |
| 005 | **服务端零第三方依赖**（纯 stdlib） | 部署简单性 > 功能丰富度；`drill/tests` 用 `unittest` 统一而非 pytest |

---

## 1. 分层架构（终版，含评审修正后的真实威胁模型）

```
┌─────────────────────────────────────────────────────────────┐
│ 客户端（fork 改造，KaTeX，手机优先）                            │
│   │ 废弃 localStorage —— 唯一存储交互 = api.js 同步桥          │
│   │ ① 进度数据: blob 去抖同步（PUT 带版本号）                   │
│   │ ② 判定: 原始输入上传 /api/judge，服务端独占判定             │
│   │ ③ LLM 讲解: 直连模型 API（用户自带 key，仅限讲解侧）         │
│   │    ⚠️ 此线路绕过服务端 —— 评审修正：威胁模型必须包含它        │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTPS（拉取式，无推送）
        Caddy(Docker, Cloudflare DNS-01, math.zhu2006.xyz)
                       │ reverse_proxy 127.0.0.1:8081
┌──────────────────────▼──────────────────────────────────────┐
│ math-drill server（Python 3.12 stdlib, 零依赖）               │
│   http.server 路由 + judge.py + store.py(假设 blob 持久化)     │
│   Phase 2: scheduler.py（KP 记忆状态 + 带时间衰减的选题）        │
│   sqlite3 (WAL) + meta.schema_version                        │
│   判定是唯一写入口，正确性必须由服务端保证                       │
└──────────────────────┬──────────────────────────────────────┘
                       │
        离线打包：scripts/gen_bundles.py 产出 bundle → 灌入 questions 表（⚠️ 非运行时端点，见 §11.5）
        generator 总线: 数学内核(generators/*) → 离线产出 JSON
                        ↓ 部署时灌入 questions 表
```

**威胁模型表（评审根因 4 修正）**

| 通道 | 控制面 | 位置 |
|---|---|---|
| 写入 API（state/judge/daily） | **凭据门**（两种，v2.15 补第二种）：**浏览器会话 = 长效 token cookie**（HttpOnly+Secure+SameSite=Strict）+ rate-limit；**服务间 = Bearer 凭据**（见下一行）——cookie 已**不再是唯一**控制面 | server |
| **服务间凭据（Bearer，ADR-015 决策 3）** | 跨网络传输的**长寿命**凭据，**只有 TLS**（无 HttpOnly 可依赖）；**可离线重算**（拿到 token 文件的人都能推出来）；泄露半径 = 该 token 全部权限。**落点与 cookie 不同**：agent 是软件 ⇒ 凭据必须是**可读明文**，会落在 **DSH 配置 / 进程环境 / 会话与工具回显 / 反代错误日志**。域分离派生（`msg=md-agent-v1`），与 cookie **互不可替代**；轮换 token ⇒ 两条同时失效（放弃独立吊销） | server + 客户端 |
| 静态读取 | **匿名只读**（不加门；`web/tests/**` 与 dotfile 一律 403）——定案见 §13.3「静态面是否过 token 门」；原写「见 §7 开放」为悬空引用（§7 无此项） | bridge |
| LLM 直连（出网） | 用户自带 key，只走讲解链路；服务端**不设**代理，**永不**存储 key | 客户端 |
| 运维面 SSH | fail2ban 已在跑（不复述用户职责） | 服务器已有 |

---

## 2.（SUPERSEDED，仅留演进对照）仓库骨架 v1 树

> ⚠️ **本节自 v2.1 起被 §10.B 取代，v2.2 起以 §11 修订树为真值**——保留仅为演进对照，禁止照此搭骨架。
> 质检官 S3 指出的「双真相源」已由本横幅闭合。

```
math-drill/                    ← 工作名（命名开放：可换 kanm-drill 等学生最终定）
├── docs/
│   ├── ARCHITECTURE.md        # ← 本文件 v2 冻结
│   ├── JUDGE_CONTRACT.md      # 判定契约（answer_type 语义 + fail-closed 规则）
│   ├── DECISIONS.md           # ADR 记录（001-005 + 后续）
│   └── BOUNDARY.md            # 继承面边界表（2,606 行存留裁决）
├── server/
│   ├── app.py                 # http.server 入口 + 路由表 + token 中间件
│   ├── judge.py               # fail-closed 判定器（类型驱动）— [Day-1]
│   ├── store.py               # sqlite3(WAL) blob 存储 + 版本仲裁
│   ├── scheduler.py           # [P2a/2b] kp_state + 带时间衰减的加权选题
│   ├── generator_bus.py       # 生成器总线（部署时把 bundle 灌入 questions）
│   ├── report.py              # [P3] 周度薄弱报告（服务端计算）
│   └── config.py              # 常量：端口/token TTL/τ 默认值/rate-limit
├── math/                      # ← 已完成部分迁移至此
│   ├── exact.py               # 已写（454 行/30 断言）—— 唯一存量代码
│   └── generators/            # [P1] Ch1-內行列式；Ch2 矩阵……逐章追加
├── web/                       # fork 自 kaoyan-math-tutor（见 BOUNDARY.md)
│   ├── index/html/css/js/*    # 继承（$保留$清单在边界表）
│   ├── js/api.js              # [新增，~100 行] 唯一存储交互桥
│   └── js/judge-client.js     # [迁移] 判定调用 → /api/judge（移除 parseFloat）
├── scripts/
│   ├── gen_bundles.py         # 生成器 CLI → data/bundle-vN.json（可复现 seed）
│   ├── db_init.py             # schema_version 初始化 + kp 表灌入
│   └── backup_check.sh        # sqlite .backup + integrity_check（systemd timer）
├── tests/
│   ├── test_exact.py          # 已有（迁移到 unittest 统一）
│   ├── test_judge.py          # 10 例回归 + 类型边界攻击组 [Day-1 先红后绿]
│   ├── test_api.py            # 端点契约（本地起服、无外网依赖）
│   ├── test_store.py          # blob 版本仲裁/冲突合并规则单测
│   └── test_scheduler.py      # [P2b 先写] 时间衰减/饱和/新颖性/确定性等
├── deploy/
│   ├── math-drill.service     # systemd：User=math-drill, NoNewPrivileges,
│   │                          #   PrivateTmp, ProtectSystem=strict + ReadWritePaths
│   ├── caddy.block            # 站点块（并入 /root/obsidian-livesync/Caddyfile）
│   └── backup.timer           # SQLite .backup → /var/backups, 保留 7 份
├── data/                      # 运行时数据（.gitignore）
└── README.md / LICENSE / ATTRIBUTION（fork 出处 + MIT 传承）
```

---

## 3. 数据契约（字段表 + 约束，非 DDL）

### 3.1 `questions` — 题库（服务端持有，客户端 bundle 同源离线生成）

> 命名统一（回应复核 M1）：v2 初稿此处写 `qa`，而 ADR-007 / JUDGE_CONTRACT §6 / §1 图用 `questions`。**统一定为 `questions`**，全仓不再出现 `qa` 作为表名。

| 字段 | 类型 | 约束/说明 |
|---|---|---|
| id | TEXT | 稳定 id = hash(gen_params)；同参数再生同题 |
| bundle_version | INT | 生成器产出包版本 |
| kid | TEXT | 知识点 id（与 kp.id 对齐；FK 软约束） |
| type | TEXT | 'choice' / 'blank' / 'solution' |
| **answer_type** | TEXT | **rational 一体化（integer 并入）** / vector / matrix / interval / set / symbolic / self_report |
| stem | TEXT | 题干（KaTeX 语法） |
| options | TEXT? | 选择题 JSON |
| answer | TEXT | 规范答案（可序列化） |
| analysis | TEXT? | 解析（pitfalls/kp 说明） |
| difficulty | INT | 1-4 |
| gen_params | TEXT? | 生成参数快照（可复现性保证） |
| source | TEXT | 'generated' / 'custom_json' / （未来）'textbook' |

**约束**：`answer_type='symbolic'` 的题 → 判定只走 self_report 通道，服务端不猜。

### 3.2 `kp`（知识点注册表 —— 从基底 68 考点树导入服务端，解关注册完整性）

| 字段 | 说明 |
|---|---|
| id | 'c1n1'…（与基底 kid 同构，白嫖评审认可的资产） |
| title / chapter / subject | 展示用 |
| exam | 'all' / ['m1'] / ['m1','m3']（基底现成的考纲作用域，Q6 补充 advantageous） |
| related | 知识点边（薄弱点传播用，Phase 2b） |

### 3.3 `attempts`（append-only，不可修改）

| 字段 | 说明 |
|---|---|
| id INTEGER PK | 单调递增（blob 合并的仲裁键之一） |
| ts | 服务端时间（**不接受客户端时间**，防时钟偏差） |
| qid / kid / correct(0/1/NULL) | |
| verdict | 'server_true' / 'server_false' / 'self_reported' / 'undecidable' |
| user_ms / device | 可选 |

### 3.4 `kp_state`（Phase 2a 才启用；先定粒度）

| 字段 | 说明 |
|---|---|
| kid PK | **粒度 = (user, kid) 一行**——评审定案：一阶决策就是粒度 |
| ef/interval/reps/lapses/due/last_review | SM-2 迁移版 |
| stability/difficulty（P4 可选） | FSRS 二阶字段（预留，不填） |

### 3.5 Sync 契约（blob 合并规则，N=1 简化版）

> ⚠️ **真值位置（v2.7）**：本表的真值已归入 `contracts/blob_merge.md`（§11.9 树）。此处为**人读摘录**；两处不一致时以 `contracts/blob_merge.md` 为准。

| 顶层字段 | 合并规则 |
|---|---|
| ~~attempts[]~~ | ~~append-only 按 id 合并~~ **← 已废弃（v2.5）：ADR-007 已将 attempts 退役出 blob**，服务端 `attempts` 表为唯一事实源；照本行实现会产生双写路径 |
| cards / daily | 按 updated_at **newer-wins** |
| settings | **server 是真相源**；客户端改设置=显式 PUT 特殊段（避免两个设备设置互踩） |
| checkins / game / notes | newer-wins |

冲突仲裁 = 服务端 server_version 单调递增 + 客户端 base_version 匹配；失败 → 返回 409 + 服务端最新 blob。

---

## 4. 判定契约（JUDGE_CONTRACT v0，Day-1 落地）

- **输入**：`{qid, kid, raw_answer:str, answer_type?, user_ms?}`
- **判定器行为**（fail-closed 三分支）：
  1. `rational/vector/matrix` → 服务端解析为规范型 → 精确比对 → correct ∈ {true,false}
  2. 解析失败或类型过界 → `undecidable` → **降级 self_report**（记录 verdict，绝不猜）
  3. `symbolic/self_report` → 一等公民通道，用户读标准答案后自评
- **回归命令**：评审给的 10 例（5 攻击 5 控制）→ `tests/test_judge.py` 首尾对齐；**目标 10/10 且 0 假阳性**
- `norm()` 保留（fork 里最值钱的资产），`parseFloat` 回退**删除**（评审根因 2）

---

## 5. 选题契约（Phase 2b，先写测试后实现）

**权重输入必须是当前时刻可计算的**（评审原话，强制约束）：

```
输入（全部可由服务端注入，无历史累计裸值）:
  win_rate(kid, N=8)          # 近 N 次（默认 8），无 recency-weight，暂不做注入
  days_since_last(kid)
  due_pressure(kid)           # SM-2 due 步迫度
  inherit_wrongs_id_content   # 历史 wrongs 计数必须经 exp(-Δdays/τ) 衰减
  τ 默认 10 天（`config/server.toml` → `[picker] tau_days`，见 §13）
禁止: 无时间边界的历史累计直接加权重（评审根因 1 的反面教材）
```

**先写的单测清单**（TDD 顺序锁死）：
1. 饱和：连续答对 8 次 → 权重不再上升（防"永久简单"）
2. 衰减：同错题 30 天后不再支配权重（防「永久惩罚」——评审立案的镜像病）
3. 新颖性：未练过的 KP 仍排前
4. 确定性：给定 seed 同输入同输出（防 UI 层依赖 rand 影响可复现性）
5. 空态：全新 KP 无状态时的默认权重（N=1 用户第一天的体验）
6. 数量守恒：N=1 升到每日 5-8 题时权重排序稳定（不翻转）

**降级总则**：任何时候判定失败或状态缺失，系统往**保守**侧掉（新 KP 默认权重=经典基底权重，不凭空造新数据）。

---

## 6. 验收门（Phase Gate，措辞要可测量）

| Phase | 验收门槛（不达标不进下一阶段） |
|---|---|
| **1 最小闭环** | ① blob 同步两台设备互通（手动验证清单）；② 判定 10/10 + 0 假阳性；③ **线代 Ch1（行列式）≥40 题可生成**（Ch2 移出 Phase 1 门槛，回应复核 M6）；④ systemd 正常重启自恢复；⑤ **连续 7 天 × 每天 2 题**真实使用 |
| **2a 粒度/状态** | ① state.cards 混合键迁移完成；② kp_state 主键定义 + 迁移脚本；③ 45 save() 全部经服务端（无本地写余留） |
| **2b 选题重写** | ① §5 全部单测先红后绿；② 判定链路无 LLM 参与（审计 grep 证）；③ 真实使用 2 周 |
| **3 反馈** | 周报字段成型 + 错题准入 Obsidian vault（走已知管道） |
| **4 题源扩展** | 高数 Ch ≥2 章机动 + sympy 评估报告（此时**才**决策是否引入） |
| **5 Agent 层** | **以 DSH 为宿主、考研数学做插件**——形态、分期、鉴权、代价与终态触发条件**全部见 `docs/DECISIONS.md` 的 ADR-015**（本行原写"可选 DSH 插件薄客户端"，v2.13 改指 ADR-015；两者不是同一形态，以 ADR-015 为准）。判定链路无 LLM **不变**。 |

---

## 7. 开放微决策（**v2.10 全部收口**）

> 状态：本表**已关闭**。关闭姿势 = 改行加结论，**不删行**（与本文件「不删除、追加状态」的 ADR 纪律一致）。

| # | 决策 | 结论 | 关闭时点 |
|---|---|---|---|
| D1 | 项目名 | **`math-drill`**（T0 起冻结）——⚠️ 原文「工作名，开源前可换」是**错的**：名字已硬编码进 `User/Group=math-drill`（§12.1）、`StateDirectory=math-drill`、`/etc/math-drill/token`、`/var/lib/math-drill`、`/var/log/math-drill.log`、`/opt/math-drill` ⇒ 真窗口是 **T0 前，或永不**；T0 是唯一零成本窗口（名字归 D1，域名子域 `math.zhu2006.xyz` 另计） | v2.10 |
| D2 | `integer` 是否独立于 `rational` | 已定：**合并**（减少类型面，ADR-003 侧） | v2.0 |
| D3 | classroom 处置 | 已定：**隐藏（`enabled=false`）、代码保留**——与 `BOUNDARY.md` 对 `js/classroom.js`（851 行）的既有裁定一致；执行面落在 **T4**（隐藏入口）与 **T5**（fork 测试面） | v2.10 |
| D4 | 认证方案 | 已定：**长效 token cookie（HttpOnly + Secure + SameSite=Strict）** + 派生式会话（§13.3）；CF Access 留待 Phase 3 评估 | v2.10 |
| D5 | τ 衰减常数 | 已定：**10 天**（落点 `config/server.toml` 的 `[picker] tau_days`，P2b 实测后可调） | v2.10 |
| D6 | fork node 测试落点 | 已定：**`web/tests/`**（整目录搬迁；§11.9 树与 §13.2 的 403 规则已引用它） | v2.10 |

---

## 8. 明确不在 v1 范围（防 scope creep 的边界清单）

- ❌ 多用户 / auth 体系（单用户架构，blob 语义即自证）
- ❌ 推送通知（决策人明确拒绝——容易出 bug）
- ❌ sympy / 任何 CAS（P4 才评估，做能力增量不做阻塞）
- ❌ oplog（方案 A 定案；真实多端冲突 >0/月 才升级）
- ❌ 解答题自动判定（self_report 是一等公民通道，评审 Q7 已裁决）
- ❌ 教材课后题录入管道（P3+ 按需求，暂无数据源）
- ✅ 保留：fork 的 game.js / cards.js（无 key 降级）/ llm.js（讲解侧）/ agent.js（不接线保留）
- ⛔ **红线**：真题库（墨题库）的题目数据**永远不进开源仓库**；fork 作者未声明题目数据授权链——开源仓库里只舒服代码 + 我方生成器 + customQ 用户自带内容

---

## 9. 变更记录

| 版本 | 日期 | 内容 |
|---|---|---|
| v1 | 2026-09-14 | 初稿（见 PCA 记录） |
| v1.1 | 2026-09-17 | 外部评审请求发出前的技术请求文档 |
| v2 | 2026-09-17 | **冻结骨架**：吸收评审 5 条修改（判定契约/blob A/选题层重定位/边界表/数字校准） |
| **v2.1** | 2026-09-17 | **§2 仓库骨架被 §10 取代** —— 按决策人 whale-moe 项目的实践章法改为「一切皆模块」（ADR-006）；§1/§3/§4/§5/§6 契约不变 |
| **v2.2** | 2026-09-17 | **§11 追加**：质检官三条地基石定案（core 增 `exact/` / 配置 stdlib 化 TOML+JSON / kp_state=段+attempts 退役出 blob）；允许依赖矩阵 6×6；路由统一 bridge 挂载 `/m/*`；S3 全收 |
| **v2.3** | 2026-09-17 | **三份配套设计文档落地**：`docs/JUDGE_CONTRACT.md`（判定契约 v1：不变量 I1-I6、answer_type 表、fail-closed 决策树、10 例回归 + 6 例类型边界 + 3 条性质测试）、`docs/BOUNDARY.md`（继承面逐文件裁定：源码 9,609 行真值、三处硬接缝、状态字段处置、测试重整、删除候选、合规红线）、`docs/MODULE_TEMPLATE.md`（模块四件套 + MANIFEST 字段表 + 两回调契约 + 七步清单 + 七道质量门 + 反模式表）。另更正 §G 算术错误（源码 9,609 非 10,653） |
| **v2.4** | 2026-09-17 | **执行交接单落地**：`docs/IMPLEMENTATION_BRIEF.md`（角色与权限边界、施工前必读顺序、10 条硬约束及其验收方式、T0-T8 任务序列与每任务验收命令/证据/停止条件、提交规范、六类必须停下的情况、开放决策表、Phase 1 交付物清单）。配套产出：**v2.3** 的 `JUDGE_CONTRACT.md` / `BOUNDARY.md` / `MODULE_TEMPLATE.md`。设计侧至此冻结，执行交 Codex |
| **v2.5** | 2026-09-17 | **消歧补丁**（回应独立复核的 6 条硬悬空 + 7 条次要项，不动设计结论）：① 新增 **§11.9 真值树**（合并版，取代所有「§11.4 树」悬空引用）② 新增 **§12 部署规格**（T7 原先指向不存在的 §3.6）③ **入口点定案 = `python3 -m bridge.api`，删 `core/server.py`**（消除 core→bridge 违规边）④ 新增 **§11.4.1 装载豁免**（依赖纪律与激活器的接缝，含 test_dep_rules 三项检查）⑤ 矩阵 core 行补 `contracts ✓`（与 T1 冲突）⑥ `config/modules.yaml` → `.toml`（与禁 YAML 冲突）⑦ 表名统一 `questions`、§3.5 attempts 行标废弃、`/api/questions` 标注为非端点、Phase 1 题源统一为 Ch1 |
| **v2.6** | 2026-09-17 | **复核第二轮修复**（2 处字面矛盾 + 2 处新缺口 + 卫生）：① T3 产出改正（`core/server.py` → `core/registry.py`）② H10/T5 命令路径改 `node web/tests/run-all.js`③ 新增 **§13 配置与凭据落点**（常量入 `config/server.toml`、token 入 `/etc/math-drill/token` 600 + env 注入 + 缺失拒启、`/setup?t=` 一次性下发 HttpOnly+Secure+SameSite=Strict、轮换流程、验收四项）④ 静态根定案 = `web/`（入口 `web/index.html`，`web/tests/**` 与 dotfile 一律 403），取消含糊的 `web/pages/`⑤ §10.B 补 SUPERSEDED 标记、行内星号误用修正、τ 引用改指 §13） |
| **v2.7** | 2026-09-17 | **第三轮定点修正**（4 条阻塞 + 3 条清单；含 v2.6 补丁自身引入的 2 条）：① §11.9 `config/` 补 `server.toml` + `server.example.toml`（树 ↔ §13 对撞，B1）② `/setup` 定性为**唯一不过 token 门的引导端点**（B2）③ §12.1 `Environment` 补 `MATH_DRILL_TOKEN_FILE` + 增 `StateDirectory` + `data_dir` 改单源（B3a/c/d）④ §13.3 会话值改 **HMAC 派生**（零存储，「轮换即失效」首次真正成立，B4）⑤ 限速语义写死（按 IP / 固定窗口 / **只计失败** / 成功清零，C-1）⑥ 上游 pin `82c0144`（C-2）⑦ §3.5 标注真值归 `contracts/blob_merge.md`（C-3）⑧ T7 验收 6 → **12 项** + 禁止 `docker compose up -d`、`caddy validate` 先行、回滚 sha256 校验。**驳回** B3b（`append:` 日志由 PID 1 在单元命名空间外打开，不受 `ProtectSystem=strict` 限制，`man 5 systemd.exec` 佐证） |
| **v2.8** | 2026-09-17 | **第四轮复核修复**（2 阻塞 + **13 清单**）——15 处逐条见 `DECISIONS.md`「ADR-012 · v2.8 追加」；此处只点前 6 类：① **端口单源**（§12.1 `ExecStart` 去参，绑定只读 `config/server.toml`）② **施工单 T3 验收**补 `/setup` 例外（原「无例外面」字面不可满足；v2.7 漏改的第三处）③ §13.3 写死静态面与鉴权次序（越权 403 先于鉴权 401，静态面匿名可读）④ §13.3 补 T3 凭据注入合规解（临时 token 文件 + monkeypatch，不落夹具）⑤ 真值树补 `core/exact/__init__.py`（实测：无它 `from core.exact import det` 报 ImportError）、补 `tests/test_registry.py`、Ch2–Ch6 省略号改为「Phase 1 不预建」⑥ 顶层域清单补 `data/`；§1 威胁模型「见 §7 开放」悬空改指 §13.3；限速语义按端点分域。**维持** v2.7 对 B3b 的驳回。⚠️ v2.9 更正：本行表头原写「6 清单」，实为 13（账本漏记 5 条，其中含 logrotate 残值） |
| **v2.9** | 2026-09-17 | **第四轮定点复核的三条同型回归 + 护栏立项**：① 账本更正（上行的「6 清单」→ 13，并补指针）② `tests/test_registry.py` 从 `[T0]` 改标 **`[T3]`**（`core/registry.py` 是 T3 产出，T0 无被测对象；原并列写法会被读成"越界/空壳/红"三解）③ `config/server.toml` 的 `data_dir` 注释「开发态可覆盖」改为「改本文件即可（无 env/CLI 覆盖）」，与 §13.1 单源口径对齐 ④ **新增 §14：`scripts/refcheck.py` 立项**（三类机械检查 + 豁免表 + 负例自测要求），把四轮来的"改 A 没回扫 B"从人眼核对改为机器红/绿 |
| **v2.13** | 2026-09-19 | **ADR-015 入库同批**：① **§11.9 真值树新增顶层域 `dsh/`**（DSH 插件集宿主层，形态全以 ADR-015 为准；目录尚未创建）② **三条纪律第 1 条的顶层域清单补 `dsh`** ③ **§6 验收门第 5 行「Agent 层」由"可选 DSH 插件薄客户端"改指 ADR-015** —— 两句不是同一形态。⚠️ **账本更正**：本表此前跳号——`v2.10` / `v2.11` / `v2.12` 三个版本号已在正文中使用（§7 标题、§12.2 注、§13.3 注）却**从未入表**，为既有漂移，此处如实记录，不补造内容。 |
| **v2.14** | 2026-09-19 | **Bearer 施工前置的仓库侧两处修正（回应 Bearer 设计规格第二轮评审的 L1，与既存泄露面实测）**：① **§13.1 限速语义注①改计数键**：原写「计数键 = 来源 IP」，与 **ADR-015 决策 3「按凭据分桶」正相反**（评审核实 L1：两条**曾同时在本仓库里**，且全文 grep `Bearer\|服务间\|凭据分桶` = 0 命中）⇒ 改为「**按身份分桶**（浏览器/未鉴权 → 来源 IP；**服务间凭据 → `agent:<sha256[:16]>`**）」并**如实标注落地状态**：该档在 Bearer 落地前**实现里是空的**。⚠️ **不改任何数值**（`api_per_minute = 60` 原样）⇒ refcheck 的 C2 单源值清单**不受影响**；本处**无机械护栏**（C2 只比值不查语义），只能靠 ADR 纪律。② **新增实测依据**：部署态 `client_address` 恒为 `127.0.0.1`（反代在后、未读 `X-Forwarded-For`）⇒ 现有"来源 IP"档**退化为单一全局桶**。③ **§13.3⑤ 加实测更正（既存缺陷，登记不修）**：请求行整条进日志 ⇒ `/setup?t=` 的**主 token 已明文落盘 10 次**；文件权限 **0644**；处置待办 = 不记 query + 收 0640 + 显式 `LogFileMode=`。④ **第三轮评审 N1/N2 顺带修正**：§13.1 代码块内 `api_per_minute` 的注释与 `config/server.toml:15` 的「每来源 IP」一并改「**每桶**」（与注① 相隔 8 行、原为自相打架；C2 只比值不查语义 ⇒ 改前改后都全绿，属无护栏处）；§13.3⑤ 注追加 **④「`/setup` 的锁在部署态也是全局的」**（任何人 3 次错 `?t=` ⇒ 对所有人锁 1 小时，含运营者，窗口内无法自救除重启），**键不改但登记在明处**。 |
| **v2.15** | 2026-09-19 | **ADR-015 决策 3 落地：服务间 Bearer 凭据（施工前置第 4 条完成）**。规格 = `~/workspaces/claude/任务-math-drill-Bearer设计评审-20260919.md`（三轮评审：v1「不可施工，2 阻塞」→ v2「仍不可施工，B3′/B4」→ v3 三问全过 → v3.1 收 7 条清单）。① **凭据派生**：新增 `AGENT_MSG = b"md-agent-v1"` 与 `agent_value()`（域分离；与 `session_value` 同源不同域、互不可推导）② **身份判定单点**：新增 `bearer_of()` / `identity()`（`browser`/`agent`/`anon`）/ `bucket_key()`，`authed()` 改为 `identity != "anon"`（不再自己比 cookie）③ **限速分桶**：`hit_api` 形参 `ip` → `bucket`，唯一调用点 `:321` 改传 `bucket_key(self)`；**`/setup` 三个调用点仍按 IP**（鉴权前的引导入口，改了会静默失效）④ **修既存 B2**：`_refresh_cookie` 由**无条件**改为**仅 `browser`** —— 原实现会把浏览器会话值经 `Set-Cookie` 发给持 agent 凭据者 ⑤ **同批文档回扫（本变更自己的"兄弟项"）**：§1 威胁模型表**新增「服务间凭据」一行并改写 `:53`**；§11.5 两处、§11.9 树注、§13.2 端点表、§13.3 静态面注、T7 验收②、`IMPLEMENTATION_BRIEF` 验收段的「token 门」措辞一并改「**凭据门**」 ⑥ **测试**：`tests/test_api.py` 新增 12 条（规格 §3.8 用例 1–15 的可自动化部分），并**修测试自身结构** —— `RateLimitCase` 原继承整套契约用例，额度压到 3/min 后会把"4 次错凭据都该 401"变成限速 429（假红），故拆出 `ServerCase` 只放夹具。**⚠️ 部署态尚未生效**（仓库已改，服务器仍是旧构建，随下次部署生效）。 |

| **v2.16** | 2026-09-19 | **`dsh/` 骨架落地：桥接插件的宿主半边（ADR-015 分期 Phase A）**。① **目录建成**：`dsh/README.md` + `dsh/math-drill-plugin/`（`package.json` 声明 `dsh.bundle.patch`；`cordis.patch.yml` 只 `insert` 一行；`src/` 五个文件；`tools/link-dsh-deps.mjs`；`tests/`）② **接入面**：`dsh plugin --profile <name> add <本地路径>` ⇒ pnpm 链接 + loader 按 `dsh.bundle.patch` **自动 reconcile 进 `dsh.profile.bundles`**（实测：profile 的 `dsh.profile.bundles` 由 2 → 3 项，`--dump-config` 里出现 `id: math-drill-dsh`）③ **能力**：两个**只读**工具 `math_drill_progress` / `math_drill_today`（Bearer 凭据，0600 文件 + 环境变量覆盖）④ **红线进代码**：`src/client.js` **只有 GET**（写面不存在，ADR-015 决策 5/代价 5）；`src/summarize.js` 的 `stripQuestionAnswers` **剥掉 `/api/daily` 的 `answer`/`analysis`**（agent 在讲解侧，不在答案侧）；⑤ **护栏**：`node --test` **17 条**（凭据纪律 / wire 行为 / 红线 / 接线；含真调 `apply()` 与真 `defineTool`）⑥ **机械护栏补位**：`scripts/refcheck.py` 的 `TOP_DOMAINS` 补 `dsh`（v2.13 登记的"本行的正确性不靠检查器"到此闭合）；`.gitignore` 增 `node_modules/`（插件依赖链接可再生产）。⚠️ **两条实测发现（都是跑出来的，不是读出来的）**：**(a)** `link:` 装的插件**必须自带可解析的 `@deepseek-ai/*`** —— Node 按包的真实路径做父级查找，走不到 `$DSH_HOME/profiles/node_modules`，缺失时**整个插件树拒绝加载**（宿主启动失败，不是"功能没开"）；故有 `tools/link-dsh-deps.mjs`（照生态惯例建插件自己的 `node_modules`，但**不联网**：链到本机 DSH 的同名包，版本必然等于宿主）。**(b)** 本机 `$DSH_HOME/profiles/node_modules` **整目录悬空**（435 条断链，指向已卸载的 AppImage 挂载点 `/tmp/.mount_…`）—— 它只是"扁平回退目录"，**不是真源**；脚本因此改从安装树（`harness-versions/<hash>/packages/*/*`、`vendor/*`）取。⚠️ **部署态与仓库态**：插件读 `https://math.zhu2006.xyz`，服务器仍是 v2.15 之前的构建（Bearer 随下次部署生效）。**Phase B（客户端半边 / UI 槽位面板）未开工**：它需要 DSH 的浏览器构建产物格式（`window.__ModuleLoader__.load`），因此要先装 `tsdown` 工具链 —— 明确**不**手写 `lib/client.js` 包装（那是把构建产物当源码维护）。 |

| **v2.17** | 2026-09-19 | **Bearer 上生产 + 桥接插件装进真实 profile（ADR-015 决策 1/3 的端到端打通）**。① **生产部署面只有一个文件**：先核对 `/opt/math-drill/bridge/api.py` 的 md5 = 本地 `HEAD` 版（`62cb4827`，逐字节相同，**说明服务器无未登记的本地改动**）⇒ 备份为 `api.py.bak-20260919-233619-pre-bearer` ⇒ 覆盖新文件（md5 `592f9f5e`，644 ubuntu:netdev，**用目标机的 `/usr/bin/python3` 3.12 编译 + import 自检通过后**才重启）⇒ `systemctl restart math-drill`。**回滚 = 把 `.bak` 覆盖回去再 restart**（一条命令，见 §12）。② **生产机七项实测**（凭据值在服务器进程内派生，**全程不回显**）：匿名 `/api/state` **401** / 正确 Bearer **200 且响应不含 `Set-Cookie`**（B2 修复生效）/ cookie 值当 Bearer **401** / Bearer 值当 cookie **401** / 真 cookie **200 且仍带 `Set-Cookie`**（滑动续期未受影响）/ `/api/daily` 匿名 401·Bearer 200；静态面 `GET /` 200、`/js/app.js` 200、`/tests/run-all.js` **403**、公网入口 `https://math.zhu2006.xyz/` **200** ⇒ **手机主场景零影响**。③ **服务间凭据落到本机** `~/.dsh/math-drill/agent-credential`（**600**，65 字节；值经 ssh 管道直落文件，**不进任何会话/命令/文档**），并用该文件走**公网**实测 `/api/state`、`/api/daily` 均 200。④ **插件装进真实 web profile**：`dsh plugin --profile web add …/dsh/math-drill-plugin` ⇒ `dsh.profile.bundles` 追加 `@math-drill/dsh-plugin`（**追加在末尾，其余 11 项一字未动**）⇒ `--dump-config` 145 条目含 `math-drill-dsh` ⇒ **真实 profile 启动实测干净无错**（`dsh web --no-open --port 0`）。⚠️ **两条如实登记**：**(a)** 改前已备份 `~/.dsh/profiles/web/package.json` 与 `cordis.patch.yml`（`.bak-20260919-233544-pre-math-drill`）；`pnpm add` 顺带重写了该 profile 的 `pnpm-lock.yaml`（pnpm 自身行为，非手改）。**(b)** 生产机 `/opt/math-drill` 的 `bridge/api.py` 现在**领先其 git HEAD（fb8af77）**——本次是"文件对文件"的部署，工具链里没有 `git pull` 这一步；下次部署时须把这一步补进流程，否则 `git pull` 会静默覆盖它。 |

| **v2.18** | 2026-09-19 | **Phase B 落地：客户端半边（UI 槽位面板）—— ADR-015 分期到此两半俱全**。① **注册点**：`src/client/index.ts` 往 `conversation.input.dock`（**`list` 型 = 追加位**，官方与 ui-goal 都只 append）插一条「考研数学」状态条；**不碰任何 `single` 型槽位**（决策 6）。② **凭据不出宿主**：宿主半边新增只读路由 `GET /math-drill/summary`（`ctx.webServer.register`），浏览器只拿到**已剥掉答案**的文本摘要 —— 服务间凭据永远不进浏览器。③ **构建按生态既有路线**：官方 per-package 预设（`packages/client/tsdown.client.ts`）**不在安装包里**，故按生态惯例**镜像**它到 `tsdown.config.ts`（去掉我们用不到的 CSS Modules 段；loader 契约那三行 banner/intro/footer **逐字照搬**），产物 `lib/client.js` = `window.__ModuleLoader__.load({id, factory})` 包装；`tools/build-client.mjs` 是壳，tsdown **从本机已有的一份链入**（不联网装新依赖）。④ **实测（真机，非推理）**：真实 profile 启动干净；页面 boot graph 含 `@math-drill/dsh-plugin`；`GET /plugins/@math-drill/dsh-plugin/client.js` → **200 / 3285 B / text/javascript**；`GET /math-drill/summary` → `{"ok":true,...}` 回真数据（当时 `server_version=7`、8 道题、**无 answer/analysis**）。⑤ ⚠️ **本批自己引入过一次"宿主起不来"**（如实登记）：我把宿主路由注册的方法名猜成 `ctx.webServer.registerRoute`，真名是 **`register`**（`@deepseek-ai/dsh-host-webserver` 的 `WebServer`）⇒ **真实 profile 启动直接失败**；更糟的是**测试桩用了同一个错名字**，于是测试全绿。**修法（不是改对了就算）**：测试的桩改锚在**真实服务原型**上（`WebServer` / `ToolRuntime`），并加一条**桩自检**用例 —— 真原型上不存在的方法名必须当场抛（本项目"校验器必须先被校验"的第五条的又一次应用）。⑥ **命名更正**：原 `src/client.js`（math-drill HTTP 客户端）改名 `src/math-drill-api.js` —— 生态约定里 `src/client/` 专指**浏览器半边**，同名两义必然误读。⑦ 插件测试 **21 条**（新增：客户端产物 shape 4 项断言 + 摘要路由正/反例 + 桩自检）。 |

| **v2.19** | 2026-09-20 | **DSH 插件对标改进（B1–B4 落地 / C1 驳回 / C5 维持）** —— 依据 2026-09-20 独立评审（`~/workspaces/claude/复核报告-math-drill-DSH插件对标改进-20260920.md`，判"有保留地可施工：2 阻塞 + 13 清单 + 2 改判"）。① **B4 消掉两处真值**：新增 **`dsh/math-drill-plugin/src/shared/contract.js`**（`STATE_PATH` + `STATE_SCHEMA_VERSION` + `isStateResponse`），宿主与客户端**相对 import** ⇒ tsdown 内联；**并实测**（评审 Z1 要求）：产物里仍只 `require("react")`，purity 闸门未拦。响应体加 `schemaVersion`，客户端遇未知版本**明说**而不是硬读。② **B1 文案进 locale 字典**：`src/client/index.ts` 注册 `math-drill` 命名空间（zh/en **键对齐**，有测试），槽位注册带 `locale: NS`，组件优先用座位 `t`、无座位时回退**同一份字典**（不是第二份真值）；源码里产品可见字符串**只剩字典**（验收口径含"注释除外"）。③ **B2 样式换语义 token**：改用 `--dsw-alias-border-l2` / `--dsw-alias-brand-primary`，中性边框 `0.5px`；**不**用 `--dsw-elevation-*` —— 评审实测该前缀在本机 0.1.1-rc.1 **全树零命中**，且本元素是扁平行不是浮层。④ **B3 信息边补全包名**：`dsh.client.inject` 由 `[]` 改为 `["@deepseek-ai/dsh-client-ui-slots","@deepseek-ai/dsh-client-locale"]`（评审 Q1：该字段定义是 **package-name** 边，官方 40+ 例与本机 4 个第三方插件**无一例外**）。⑤ **C1 驳回并接受**：`immediately: true` 是**基础设施行**专用（官方 10 例全是 locale/runtime/theme/hmr 之类），我们的追加型状态条用它=滥用 ⇒ **不加**。⑥ **C5 维持不换槽位**：`composition.dock` 带 `!hero` 守卫（`ConversationRoot.tsx:156`）、`input.dock` 没有（`:164`），而 hero 对"刚开但空白的会话"也为真 ⇒ 换过去会在最该出现的时刻消失。⑦ **评审自身纠正一条**：list 型槽位**确有**影子化优先级（`ui-slots/src/index.ts:490-496` "Cell shadowing rank"）—— 我原先的担忧成立。⑧ **同批修掉评审点出的账本漂移**：真值树里的测试条数（原写 17，实为 **27**，"以实跑为准"）；`dsh/参考-官方文档与生态.md` 的素材文件名/路径对照、`--dsw-alias-*` 计数改为**两个口径**（定义 78 / 出现去重 80）、补"升级宿主前重取 `PLATFORM_MODULES`"前置条件。⑨ **未做**（评审判该做但需先查契约）：C2 工具卡片、C3 设置页、C4 斜杠命令 —— 开工前先查 `Slots.listSubTree` 与 `slash.registerSource`（`packages/extensions/ui-cordis/src/client/index.ts:168`）。 |

| **v2.20** | 2026-09-20 | **定点复查（第二轮）的账本修复：3 阻塞 + 7 清单全部就地改** —— 复查报告 `~/workspaces/claude/复核报告-math-drill-DSH插件对标改进-定点复查-20260920.md`（落地面 **14/14 全对**，账本面 3 阻塞；其判词："账本自身的假落点比落点错更毒 —— 下一轮的开工依据就是账本"）。① **假落点**：任务书 §12 声称"§5 B1 已改引 `:115`"而 §5 实际仍写 `:113` ⇒ **§5 依据行就地改成 `:115`**（并注明原值），§12 那句由假变真。② **被推翻的原句留着**（`§5` 仍引 `:24` elevation、仍写"79 个"、仍是不可执行的"从宿主导出"）⇒ **三处全部就地改写**（不追加）：改引 `web-styling.zh.md:21`+`:25`、计数改两口径（定义 78 / 出现去重 80）、B4 验收改为"共用契约 + 实测 build"。**这是本项目第二次记录"在别处追加说明、被修正原句原样留着"的形态**。③ **新文件未进真值树**：`src/shared/contract.js`（B4 契约的唯一真源）与既存的 `src/summarize.js` 都缺席 ⇒ 两处真值树（本文 §11.9 的 `dsh/` 段 + `dsh/README.md` 目录树）已补。④ **代码侧两条**：删掉**无引用方**的死导出 `SUMMARY_PATH`；`locale` **移出 `inject`** 改走 `ctx.get('locale')` —— 硬 inject 会让宿主缺该服务时**整块面板静默不激活**（比"没座位就回退"糟），并新增 1 条测试专测"没有 locale 服务也照常激活、照常注册槽位"。⑤ **live 陈述扫干净**：`dsh/README.md`（分期段/目录树/构建提醒/明确不做）、`dsh/math-drill-plugin/README.md`（"还没做 Phase B"→ 已落地那节；它进 `files`）、`DECISIONS.md:271`（"Phase B 未开工"→"也已完成"）。⚠️ **本轮我自己又踩一次同型坑**：改完 `src/client/index.ts` 直接跑测试 ⇒ 全红，因为**产物 `lib/client.js` 不会自己更新**；已在两处 README 写明"改了 `src/client/**` 必须重跑 `node tools/build-client.mjs`"。⑥ 插件测试 **28** 条（本行即当前口径）。 |

| **v2.21** | 2026-09-20 | **第三轮定点复查（复查2）的 4 条清单：2 补登记 / 1 删死码 / 1 回扫** —— 复查报告 `~/workspaces/claude/复核报告-math-drill-DSH插件对标改进-定点复查2-20260920.md`（**0 阻塞**）。① **locale 失败模式换位置了，登记旧的** ⇒ 补登记：`ctx.get('locale')` 是**一次性读取、不重试** —— 缺 locale 时面板照常出现（这是我们要的），但**locale 晚到的宿主会永久走中文回退**（新路径）。官方第三条路 `ctx.inject(deps, cb)` 能等到服务再回调，但**把槽位注册挪进回调会退回"面板可能永不出现"** ⇒ 评审判"当前实现是局部最优、不建议照搬"，**只登记**（写在插件 README 的"已知取舍"）。② ⚡ **`dsh.client.inject`（包名边）与运行期 `inject` 故意分叉，不要去"对齐"**：前者是**信息性包名边**（`manifest.ts:58`），我们留着 `@deepseek-ai/dsh-client-locale` 是"确实碰过 locale 包"的唯一记录，一致性驱动的下一轮会顺手删掉它 ⇒ 两处 README 都写明"不要对齐"。③ **删死码**：`src/client/index.ts` 的 `typeof ctx.get === 'function' ? … : ctx.locale` 兜底分支**永不执行**（`context.d.ts:28-29` 证明 `ctx.get` 恒为函数），且真执行时会报 `service "locale" is not declared`（未声明 inject 按服务名访问）⇒ 删掉，只留 `ctx.get?.('locale')`，注释里留依据。④ **回扫残留**：`dsh/math-drill-plugin/README.md` 的标题/首段与 `package.json` 的 `description` 三处同义陈述（原写"宿主半边"）一并改成"宿主半边 + 客户端半边"；任务书 §5 加"读法声明"（该节"现状"是提案时点快照，判落地看 §12–§14 与代码）。⑤ 产物重建 **7825 B**，插件测试 **28** 条全绿。⚠️ **留给下次复核前的必做项**（复查方按红线不启进程、点名要生成方跑）：**真机测挂载顺序** —— locale 相对本插件的激活先后、已注册槽位的 `locale` 选项能否事后补、`dsh.client.inject` 包边是否驱动预取；这三条同时决定 ① 与 ② 的严重度。 |

| **v2.22** | 2026-09-20 | **C2 落地：`math_drill_*` 的工具卡片**（对标清单里评审判"该做且风险最低"的一条；C3 设置页 / C4 斜杠命令仍待）。① **契约先查后写**（官方 Skill 的第一条纪律）：`tool.call.toolview` 是 **`keyed` + `scope: session`**、owner props 是 `ToolCallOwnerProps = { callId, toolName, block, cwd?, home?, openFile, inspect? }`（`packages/client/ui-tool/src/client/contract/slots.ts:29-44`），`block` 用 `'kind' in block` 判落定、落定节点带 `content: ContentBlock[]` / `isError` / `error`（`packages/client/runtime/lib/types/client/sessions/conversation.d.ts:165-185`）—— 两处出处写进新文件 `src/client/MathDrillCard.ts` 的文件头。② ⚠️ **关键发现（决定实现形态）**：官方源码注释明写 **"a keyed hit REPLACES the generic row"**（`ui-tool/.../tool-call-model.ts:29-36`）⇒ **注册了 key 却不自己渲染输出，用户就看不到工具结果**；卡片因此自己画标题 + 状态记号（⏳/✓/⚠️）+ 正文（>12 行折叠）。③ **卡片文案也进字典**（新增 5 个键，zh/en 仍键对齐），**`dsh.client.inject` 补 `@deepseek-ai/dsh-client-ui-tool` 包边**（信息性边，说明我们确实依赖该槽位）。④ **测试 30 条**：新增 2 条（落定结果画出正文；运行中/出错两档不空白），并把原断言从"只注册 1 条"改为"1 条状态条 + 2 张卡片"（含"没有 locale 服务时三条都照常注册、都不声明命名空间"）。⑤ 产物重建 **11139 B**，`require` 仍只有 `react`（新增卡片走相对 import ⇒ 内联，未破 purity 闸门）。 |

| **v2.23** | 2026-09-20 | **C4 落地：`/math` 斜杠命令**（对标清单里"契约先查再写"的第二项）。① **契约（本机 0.1.1-rc.1 逐字核过）**：`ctx.commands.register({ name, description, input:{hint}, handler })`；handler 收 `CommandInvocation{ commandId, agent, rawInput, attachments, signal }`、返回 `{kind:'success', text?}` / `{kind:'error', text}`；名字须匹配 `^[a-z][a-z0-9_-]*$`（`packages/interaction/commands/src/index.ts:28/34-48`、`…/types.ts:27-34`；本机现成用例 `/goal` = `command-goal/src/index.ts:190`、`/feedback` = `command-feedback/src/index.ts:101`）。② **三条分支**：`/math`·`/math progress` → 进度；`/math today` → 今日题单（**答案与解析不在内**）；其它参数 → `{kind:'error'}` + 用法提示；失败（缺凭据 / 401 / 连不上）也回 `error` 文本而**不抛**。③ ⚠️ **`commands` 走 `ctx.get` 而非 `inject`** —— 沿用 locale 那条教训：硬 inject 会在缺该服务的宿主上把**工具与路由一起拖住**（静默不激活）；现在只是少一条命令，且有测试专门盯这条路径。④ **测试 33 条**（+3：三分支 / 缺凭据报错 / 无 commands 服务时不拖住工具与路由）；`tools/link-dsh-deps.mjs` 增链 `@deepseek-ai/dsh-commands`，让测试桩仍锚在**真实服务原型**上（不自己发明方法名）。 |

| **v2.24** | 2026-09-20 | **本地"干净环境"测试台 + 两个工具链 bug**。决策人要求"别在日常 DSH（插件很多）上验证，要模拟服务器那种轻量新环境、走 web 端口" ⇒ 新增 **`dsh/tools/local-test-env.sh`**：独立 `DSH_HOME`（默认 `~/dsh-math-test`）＋最小 profile（**只 `@deepseek-ai/dsh-base` + `dsh-web-app` + 本插件**，实测 bundles 恰好 3 项）＋凭据复制为 0600；子命令 `setup / start / check / stop`，默认端口 **39192**（避开日常 39191），**完全不碰 `~/.dsh`**。**实测通过**：首页 200、boot roster 含 `@math-drill/dsh-plugin`、`/plugins/…/client.js` 200、`/math-drill/summary` 回真数据（`schemaVersion:1`）。② ⚠️ **新环境立刻抓出两个工具链 bug（都不是插件本身的）**：**(a)** 脚本原先只赋 `DSH_HOME` 未 `export` ⇒ 子进程 `dsh plugin add` 跑到**真实 `~/.dsh`** 上，"干净 profile"根本没建，而自检还在真 profile 上"通过"（自检与被检对象错位）；**(b)** `tools/link-dsh-deps.mjs` 的安装树扫描白名单只含**运行期**依赖 ⇒ 两份**测试期**依赖（`dsh-host-webserver` / `dsh-commands`）只能靠 profile 的扁平回退目录解析，而该目录指向 **AppImage 挂载点的临时链接**（桌面端一退出就断）⇒ 桌面端没在跑时 setup 直接失败；同时 `tsdown` 的搜索根必须**同时**看真实 `~/.dsh` 与 `$DSH_HOME`（它住在 `~/.dsh/dsh-browser` 的 store 里）。两处均已修 + 注释留因。③ ⚠️ **另一条环境事实（非本仓库问题，但影响验证）**：决策人日常桌面端是 **Aug-21 的 AppImage（旧一代 harness）**，而 `~/.dsh/.credentials.yaml` 自 9/8 起是 **versioned 格式**（`version: 1` + `refs:`）⇒ 桌面端启动即失败；**已把该文件退回旧格式（扁平映射）并留备份**，同时告知"新版 CLI 会自动迁移回 versioned ⇒ 两个入口别混用"。 |

| **v2.25** | 2026-09-20 | **UI 美化 + 公式渲染（回应决策人「公式没渲染出来 / 不够好看」）**。① **渲染件换官方的**：`@deepseek-ai/dsh-client-ui-primitives` 的 `MarkdownText({ text })`（内置 KaTeX）—— 该包**本来就在 `build/web-platform.ts` 的平台表里**、其 CSS 随宿主加载 ⇒ **零新依赖、零新机制**；卡片与状态条共用。产物 `require` 从 1 件（react）变 2 件（+ui-primitives），**都在平台表内**，purity 闸门未破。② **裸 LaTeX 包定界符**：题库题面是中文与数学式混排、`\begin{vmatrix}…\end{vmatrix}` **没有 `$`** ⇒ markdown 不当数学渲染、用户看到反斜杠；宿主侧 `summarize.js` 新增 `toMarkdownMath()` 把数学环境包成 `$$…$$`（实测：状态路由文本出现 **16** 处 `$$`，题面渲染为「计算范德蒙德行列式 `$$\begin{vmatrix}…\end{vmatrix}$$` 的值。」）。③ **卡片正文不再按行截断**（按行截会把矩阵公式截半）。④ 状态条加 `--dsw-alias-bg-layer-1` 底色与 10px 圆角，正文由 `<pre>` 纯文本改为 markdown。⑤ **测试 35 条**（+2：`toMarkdownMath` 单测 + `summarizeDaily` 端到端）。⑥ 客户端测试的 `require` 桩同步允许平台表内的第二件模块（表外仍当场报错）。 |

| **v2.26** | 2026-09-20 | **UI 第二轮：换成官方组件形态（状态丸 + 折叠行）**。① **状态条改一行式**：原来是多行正文塞在窄条里（顶开输入区、难扫）⇒ 现在 `[考研数学] ⚡ 今日 0/7 · 🎯 还有 N 天 · 🔥 N 分钟 · 数学一 [↻]`，明细留给 `/math` 与卡片（对标 `statusbar-config` / `lookatstudy` 的形态）。为此**契约加字段 `brief` 并升 `STATE_SCHEMA_VERSION: 1 → 2`**（本插件两半同包同批更新；客户端遇未知版本仍会**明说**而不是硬读）。② **标签用官方 `Pill`**（无 `onClick` 时渲染 `<span>`），状态条圆角 999px、底色 `--dsw-alias-bg-layer-1`。③ **卡片改用官方 `DisclosureRow`**（**受控**：`open` / `onToggle`；我们默认**展开** —— 决策人的抱怨正是"看不到东西"），头部 `icon` 是 `Pill`（✓/⏳/⚠️）+ 标题带首行摘要，正文仍由 `MarkdownText` 渲染（公式）。④ **测试 37 条**（+2：`summarizeBrief` 单行/无开局两例；另在接线测试里断言响应带单行 `brief`）。⑤ 实测（干净测试环境，端口 39192）：`{"schemaVersion":2,"ok":true,"brief":"⚡ 今日 0/7",…}`。 |

| **v2.27** | 2026-09-20 | **方向校正（决策人定调）：DSH 不做"题目的第二展示面"，插件只做"数据桥 + 小组件"**。决策人原话：题目/做题/解析**都在研数控制台**；DSH 的价值是 **agent**，插件要做的是**实时与研数 web 互通**、用**几个小组件**展示必要进度数据，并在"真正交流产生数据"后**写回控制台**。① 据此**工具改为只回数据**：`math_drill_today` 现在回「题数 / 考点分布 / 难度分布 / 题型分布 / **题号**」，**不回题面、不回答案**（实测：`今日题单：8 题 · 考点：l1n1×8 · 难度：3×4、4×2… · 题号：lin.det.af13…`）。② **删除 `toMarkdownMath()` 及其测试**：题面不再进 DSH ⇒ 那个"把裸 LaTeX 包成 `$$`"的函数成了死码（本项目对死码零容忍——上轮刚删过一个死导出）；将来若做"按需取单题"（`math_drill_question <id>`）再把它加回来。③ `MarkdownText`（公式/markdown 渲染件）**保留**：进度条、复盘、考点分布这些**数据**仍然要排版渲染。④ 测试 35 条（−2 公式包裹、+2 数据面口径；红线断言改为"连题面都不回"）。⚠️ **下一步的形状（待决策人拍板）**：agent **写回控制台**需要**服务端新增读写面**（attempts 按 ADR-007 由 judge 独占写入、且当前**没有任何 attempts 读端点**）——那属于 bridge/core 侧的改动，不在插件内。 |
| **v2.29** | 2026-09-21 | **题库浏览（栏目 / 题卡 / 详情）+ agent 复盘落点 —— ADR-017**。决策人 2026-09-21 口述：左侧栏按学科分「栏目」，栏目内每题一张卡片、点进详情看**难度系数**；**没做过只给题面**，**做对/做错给 agent 写的复盘**；栏目内另有完成度 / 综合评分。① **落点用既有模块路由**：`modules/qbank/` 由 P3 预留窗口（`enabled=false`、`rpc` 空）变为 **`phase:"1"` + `rpc:["list","detail"]`**，只走 `/m/qbank/*` ⇒ **bridge 自有端点集合仍是五个**（§11.5 不动，refcheck C2b 不受影响）。② **新增表 `agent_notes`**（`qid/attempt_id/kind/summary/reason/author/src/ts`，core 建表）——**只读暴露，无写端点**（ADR-015 决策 5 与 ADR-007 都不破）；`Store.record_note()` 目前只有离线灌库/演示调用。③ **不回答案用结构保证**：新增 `Store.list_question_views()/get_question_view()`，其**列白名单 `_VIEW_COLS` 里根本没有 answer/analysis**（不靠"调用方记得删"）。④ ⚠️ **修一处静默丢弃**：`/m/` 分支原来只把 JSON body 当入参（`_read_json()`），模块 README 里写死的 `GET /m/<模块>/<rpc>?k=v` 形态下**查询串被无声丢掉**（模块只拿到 `{}` 还不报错）⇒ 入参改为 **body ⊕ 查询串**（查询串优先）。⑤ **前端**：`web/js/qbank.js`（新增；栏目页 = 4 个小组件 + 题卡墙，详情页 = 题面 + 作答史 + 复盘）＋ `index.html` 的「题库」栏目组（**学科清单不写死**，按接口现填）＋ `api.js` 的两个薄封装（**唯一 HTTP 出口不变**）＋ `app.js` 开一扇窄窗 `MDShell`（只有 esc/md/head/toast 四个成员）给题库页借用,并把 `/s/*`、`/q/*` 的高亮交给 qbank 自己判。⑥ ⚠️ **同批登记三处既存账本缺口（本批不补）**：**ADR-016 只有引用没有正文**（`DECISIONS.md` 全文无此条，`git log -S` 零命中，而 `2ce67ee` 的提交标题写着"ADR-016 落地"）；**§14 引用的 `v2.28` 也没有对应变更记录行**；`modules/qbank/README.md` 原写"输入原文 ✅ 已有"与 `attempts` 表结构不符（该表**不存作答原文**，故"我当时怎么错的"在数据层无来源 —— ADR-017 代价 1 已订正）。⑦ **同批更正**：§11.9 树里 `bridge/api.py` 的"挂载 /m/* 与**三个** /api/*"是 ADR-016 扩到五个之后漏改的陈旧计数（这正属 C2b 要防的"端点计数"类，实测 C2b **没抓到**——因为它的计数短语正则只认 `恰好` 那一路）；`modules/qbank/README.md` 整份重写为落地形态。 |
| **v2.30** | 2026-09-21 | **题库浏览：首轮真机截图复核修掉三处**（同日，与 v2.29 同一批未发布）。① **卡片退化成显示题号**：`/m/qbank/list` 的 item **漏了 `stem` 字段** ⇒ 前端 `preview(item.stem \|\| item.qid)` 兜到题号（是"漏字段"，不是"渲染错"）。已补，并把断言写进测试：**题面要给、答案仍不给**。② **做完的题被压到列表尾部**：排序写成 `key=(i["done"], qid)` ⇒ `False` 先排 ⇒ 48 张未做的把 2 张做过的压到最后（截图才发现）；改成 `not i["done"]`，同组按题号。③ ⚠️ **既存 bug（非本批引入）**：`.nav-item .badge` 的 `display:flex` 是**作者样式**，会盖掉 UA 的 `[hidden]{display:none}` ⇒ `db.hidden = true` 根本藏不住，侧栏长期挂着几个红色的「0」，手机版还压在图标上；补 `.nav-item .badge[hidden], #nav-ach-badge[hidden] { display:none }`。**验证方式**：本机没有可用的 playwright 驱动（MCP 浏览器工具在本会话不可用），改用 `google-chrome --headless=new --screenshot` 逐页截屏 + `--enable-logging=stderr` 收控制台；五个页面（仪表盘 / 两个栏目页 / 三种详情状态 / 手机 390×844）**页面级 JS 报错 0 条**（唯一 CONSOLE 命中是 KDE 浏览器扩展的 portal 报错，与本站无关）。⚠️ **未验**：真实指针点击（headless 无驱动）—— 卡片是 `<a href="#/q/…">` 走既有 hashchange 路由，与直接开链接同一条代码路径。 |

---

## 10.（v2.1 追加）模块化骨架 —— 吸收决策人 whale-moe 项目的排版章法（ADR-006）

> 决策人要求：参考其 whale-moe 项目的实践（`console/modules/` 一块=一目录、`agent/widgets` 加功能=加文件、bridge 单通道、壳/内容分离）+ DSH「一切皆插件」模式，追求**强可扩展、低耦合、块状叠加**。本章取代 §2 的旧目录树成为组织真值；数据契约（§3）、判定契约（§4）、选题契约（§5）、验收门（§6）**全部不变**。

### 10.1 决策人项目的 8 条章法 → 本项目落法

| 章法（whale-moe 源码实证） | 本项目落法 |
|---|---|
| 块 = 自包含目录（`console/modules/appearance/` = module.py + page.html） | **模块 = `modules/<name>/` 目录**：module.py（接线）+ page.html（如有 UI）+ MANIFEST + 自述 + 自测 |
| 加功能=加文件骨架零改动（`agent/widgets/base.py` 基类 + `WIDGETS=[MyWidget()]`） | **加功能 = 加一个目录 + 启停表勾一行**；启停表决定显隐（隐藏 classroom 就是改这里，不改内核） |
| 扩展配方 = README 一等章节（「🧩 开发：加一个小组件」写明新文件自动获得的接线） | `docs/MODULE_TEMPLATE.md`——「加一个模块」配方，与你的 🧩 节同骨 |
| bridge = 唯一跨界通道（control_api.py：静态资源原路径 + 127.0.0.1 JSON API，mutating 入队） | `bridge/api.py` 唯一进出通道；写操作过 token 门 + rate-limit |
| 壳与内容分离（shell/ ≠ console/ ≠ agent/） | `web/`（前端壳）‖ `core/`（命脉）‖ `modules/`（功能）‖ `generators/`（题源）四分 |
| 域内再分层（agent/memory = store/retriever/extractor/embeddings） | scheduler 域内同姿势拆分（P2a）：state / due 算术 / picker / migrate 四件套 |
| patches/ 与 references/ 隔离位 | 同名采纳（fork 上游补丁留痕 + 调研材料隔离） |
| THIRD_PARTY_NOTICES.md 单独成文 | 直接采纳（正好承我们的 GPL/AGPL 传染红线） |

### 10.A 三条铁律

1. **单向依赖**：`module → core` 允许，`core → module` 禁止。core 只认 MANIFEST 不认模块名——启动由 registry 扫描装载。纪律由 `tests/test_dep_rules.py` 机械化执行（依赖方向违规 => 测试红）
2. **块内自治**：每模块 = 逻辑 + UI 如有 + 清单 + 自述 + 自己的测试；跨模块通信只有两种合法姿势（调 core 契约 / registry 事件表）
3. **命脉不插件化**：HTTP 服务、存储持久化、判定契约仲裁进 core——不可替换、不可插件（N3 属于内核不属于功能面）

### 10.B 仓库骨架 v2.1（**SUPERSEDED（v2.5）→ 见 §11.9 真值树**；仅留演进对照，禁止照此搭骨架）

> ⚠️ 与 §2 同待遇：本节自 v2.5 起降级为演进留档，**唯一真值树是 §11.9**。

```text
math-drill/
├── core/                          # 命脉，极薄
│   （无 server.py —— 进程入口 = bridge/api.py，见 §11.9 与 ADR-010）
│   ├── registry.py                # scanners: modules/ generators/ MANIFEST 校验
│   ├── store.py                   # blob 读写+版本仲裁（ADR-002）
│   └── judge.py                   # fail-closed 判定器（ADR-003）
├── modules/                       # 一切功能
│   ├── practice/                  # 答题会话（judge 客户端逻辑+记录）
│   ├── daily/                     # 每日任务单（首建锁定）
│   ├── review/                    # [P2a] SM-2/kp_state（含迁移）
│   ├── picker/                    # [P2b] 时间衰减选题器（测试先行）
│   ├── report/                    # [P3] 周度薄弱报告
│   ├── vault_export/              # [P3] 错题→Obsidian vault
│   ├── explain_llm/               # [P5] 讲解（客户端直连，服务端零代理）
│   ├── gamifier/                  # game.js 的服务端配套（默认启用）
│   └── classroom/                 # [P5, enabled=false] 隐藏入口
│      （每处 MANIFEST: name/phase/routes/tables/deps/enabled）
├── generators/                    # 插件第二现场：题源
│   ├── linalg_det/ … linalg_quad/ # 线代 Ch1-6（linalg-drill 产线并入）
│   ├── custom_json/               # 外部题源（兼容基底 customQ 格式）
│   └── textbook_import/           # [远期] 教材课后题管道
│      （每生成器 = 逻辑 + MANIFEST + 自述 + 自测）
├── web/                           # 前端壳（fork；你的 shell/ 语义）
│   ├── pages/                     # fork js 按功能块挂载
│   ├── assets/
│   └── js/api.js                  # 唯一新增接线：blob 同步桥 + judge 客户端
├── bridge/                        # 你的 bridge/ 章
│   └── api.py                     # web↔core 控制 API：token 门/限速/队列化写
├── contracts/                     # 跨块契约唯一真相源
│   ├── answer_types.py            # answer_type 枚举与结构（纯声明）
│   ├── events.md                  # registry 事件名注册表
│   └── blob_merge.md              # 合并规则真值（§3.5 移入）
├── tests/                         # 每模块同目录自测 + 跨块集中测试
│   ├── test_judge.py / test_store.py / test_api.py
│   ├── test_dep_rules.py          # 铁律 1 的机械执行者
│   └── test_picker.py             # [P2b 先写] §5 六条
├── scripts/                       # gen_bundles / db_init / backup_check
├── deploy/                        # systemd / caddy.block / backup.timer
├── docs/                          # ARCHITECTURE / JUDGE / DECISIONS / BOUNDARY
│   └── MODULE_TEMPLATE.md         # 「加一个模块」配方（同你的 🧩 会话甸）
├── patches/                       # fork 上游补丁留痕（你的 patches/ 章）
├── references/                    # 隔离位（调研/第三方材料）
├── data/  .gitignore
├── LICENSE / ATTRIBUTION
└── THIRD_PARTY_NOTICES.md         # 合规单（重申真题库数据永不入开源仓）
```

### 10.C 「加一个模块」四件套（配方骨架，P1 落地时按此填）

同你的 `base.py + WIDGETS=[...]` 姿势：
1. **MANIFEST**（声明单）：`name`（全局唯一）/ `phase` / `routes[]` / `tables[]` / `deps[]`（只许 core + events）/ `enabled`
2. **module.py**：注册路由；两个回调（`on_request` / `on_schedule`），用不到的显式声明无声回调
3. **自述 + 自测**：README.md + `tests/modules/<name>/`
4. **启停表**：`config/modules.toml` 默认开关（⚠️ v2.1 原文写 `.yaml` 与 ADR-005「全仓禁 YAML」冲突，v2.5 更正；`config/` 目录已补入 §11.9 真值树）——隐藏 classroom 时改这里，不改内核

### 10.D 生成器作为插件（题源第一现场）

- 输入 `{chapter, params, seed}` → 输出**稳定题目对象**（§3.1 字段含 `gen_params` 快照）
- **可复现门**：同输入含 seed 同输出——错题重练的前提
- 打包：`scripts/gen_bundles.py` 扫描 generators/ → `data/bundle-vN.json` → 部署灌 question 表
- **合规红线（第三次重申）**：一切真题源的 generator 令牌**只允许个人使用**，永不进开源仓库
- 修正：§5 选题契约的代码归属由 server/Modules/scheduler.py 改为 `modules/picker/`（测试仍挂 tests/test_picker.py）


---

## 11.（v2.2 追加）质检官三条地基石的裁决 —— P1/P2/P3 定案

> 质检官（冷启动复核）判定：八条章法全部为真、零代码属实、但**暂缓立骨架**直到三块地基石答完。本节即答案。裁决完成后仓库树以本节为准（**合并后的唯一真值树在 §11.9**——v2.2 初稿误写为「§11.4」，该节实为依赖矩阵）。

### 11.1 P1 · 唯一存量资产程序归属 —— **答：core 增第 5 命脉，`core/exact/`**

- **裁决**：`exact.py` 归入 **core 第 5 项**（`core/exact/`，package 存量 `drill/exact.py` P1 脚手架时迁入）。判据引用我们自己的铁律 3 原文：**「判定正确性属于内核」**——而 exact 正是让判定「精确」的那部分（det/rank/rref 供判定与生成共用），它就是命脉，按质检官的论证闭环。
- **一句话回答**：**生成器经 core 唯一导出面取得精确算术——`from core.exact import ...`；`generators → core` 这条边合法。**
- 否决掉的另两路（含代价，承接质检官论证）：塞进某个 generator ⇒ 制造 generator 横向依赖，恰是承诺不存在的边；每 generator 带副本 ⇒ 多份真值，给 N3 开缝（与 ADR-006「命脉不做可替换件」正面互斥）。
- 连带：旧 §2 的 `math/` 顶级域与 §10.B 的悬空引用一并修正（**真值树见 §11.9**）。

### 11.2 P2 · 配置格式 stdlib 化 —— **答：TOML（tomllib）为配置、JSON 为清单；YAML 全仓禁用**

- **实测证据（质检官无法登机、我方补的）**：服务器 Python 3.12.3 实跑三连——`tomllib: OK (stdlib)` / `yaml: 存在（系统级安装）/ version 3.12.3`
- **校准质检官的「部署必炸」**：在当前服务器上 yaml 恰好**在**（Ubuntu 24.04 系统附带），所以「当场炸」不成立。但质检官推理的骨架是对的：**yaml 的存在是环境随机产物**（换发行版/镜像即消失），依赖它=依赖运气。纪律不变：**全仓禁止 import yaml；若 import 必须进 deploy 说明并显式钉版**。
- 定案：
  - 模块清单 `MANIFEST` = **`manifest.json`**（stdlib json 解析；人类注释写进模块 README，不塞清单文件）
  - 启停表 = **`config/modules.toml`**（tomllib 只读解析，3.11+ stdlib；开发机 3.12.13 / 3.14.7 与服务器 3.12.3 双绿已验证）
  - `manifest` 的 schema 校验由 registry 启动时做 + `tests/test_dep_rules.py` 固化——格式错误启动即红，不给静默

### 11.3 P3 · 单一真相源的边界 —— **答：kp_state 是 blob 的段；MANIFEST 的 `tables[]` 删除**

- **裁决**：blob 持有**一切客户端自有状态**（cards/daily/settings/checkins/game/notes/**kp_state**）；`modules/review` 的 kp_state 是 blob 里的段，**不是 sqlite 表**。质检官给的二选一按「段」答——ADR-002 **无需重开**，§3.5 合并规则 **无需重写**。
- **连带修正（质检官连带揪出的真矛盾，必须写明）**：`attempts` 在 blob 合并规则 v1 表里是「append-only」——但这与「服务端 judge 独占写入事实日志」口径冲突（客户端可带病提交 attempts 数组）。**v2.2 修订：attempts 从 blob 合并规则中退役**——blob 是客户端视图（retained 为 UI 快照），**服务端 `attempts` 表为唯一事实源**（append-only，按 id 幂等并入；judge 是唯一写入者）。blob 与日志分歧以日志为准。这把「单源」语义从姿势性表述变成了可测边界。
- **MANIFEST 变更**：`tables[]` 删除，**改为 `blob_fields[]`**（声明模块读写的 blob 段名，供启停审计与 P2a 迁移扫描用）。
- **P2a 迁移形状（答质检官悬空问）**：**blob 内键迁移**——旧 `state.cards{kid 与 card.id 混键}` 迁为 `state.kp_state{kid}` 单键段；迁移器对 blob 只做纯函数变换（同引用可回滚），不触碰表。

### 11.4 允许依赖矩阵（6×6，落 `contracts/dep_matrix.toml`，`test_dep_rules.py` 读表执法）

| 域 ＼ 域 | core | modules | generators | bridge | contracts | web |
|---|---|---|---|---|---|---|
| **core** | — | ✗ | ✗ | ✗ | **✓** | ✗ |
| **modules** | ✓ | ✗（走事件） | ✗ | ✗ | ✓ | ✗ |
| **generators** | ✓ | ✗ | ✗（同侪经公共算子） | ✗ | ✓ | ✗ |
| **bridge** | ✓ | ✗ | ✗ | — | ✓ | ✗ |
| **contracts** | ✗（纯数据叶，被所有人只读依赖） | | | | — | |
| **web** | ✗（前端只经 bridge 的 HTTP 面） | ✗ | ✗ | ✓ | ✓ | |

> 注：`contracts` 是**被依赖的数据叶**——`core / modules / generators / bridge / web` 五域均可只读依赖它（列全 ✓），**它自身零依赖**。⚠️ v2.2 初稿把 core 行这一格误标为 ✗，与 T1（`core/judge.py` 必须 import `contracts/answer_types.py`）直接冲突，v2.5 已修正。另：「generators→modules 横向边」为 P1 否决项，**显式焊死为 ✗**。

### 11.4.1 装载豁免（回应复核 B5 —— 依赖纪律与激活器的接缝）

**规则**（可机械执行，`test_dep_rules.py` 据此实现）：

| 允许 | 禁止 |
|---|---|
| `core` 的**静态** import：标准库 + `core.*` + `contracts.*` | `core` 静态 import `modules.*` / `bridge.*` / `generators.*` |
| **唯一豁免**：`core/registry.py` 内的**动态装载**（运行时按清单发现并载入 bundle） | 任何其它文件出现动态装载 |
| `modules/generators` 静态 import：标准库 + `core.*` + `contracts.*` | `modules` ↔ `modules`、`generators` ↔ `modules`、`modules → bridge`、`modules → web` |
| `bridge` 静态 import：标准库 + `core.*` + `contracts.*` | `bridge → modules`（模块靠 registry 装载，不靠 import） |

**`test_dep_rules.py` 的三项检查**：
1. **AST 扫描**：解析每个 `.py` 的顶层与函数内 `import`/`from ... import`，按上表比对（`load_bundles()` 的动态路径除外）。
2. **单点检查**：`grep -rn "importlib" core/ modules/ bridge/ generators/` 只允许命中 `core/registry.py`。
3. **清单对齐**：动态载入的路径必须逐个出自 `manifest.json` 声明（不允许硬编码模块名）。

> 这条豁免是**必要的**：激活器与依赖纪律天然打架（复核 B5 指出）。写死才有测试可写。

### 11.5 路由权威与权限门的落位（质检官 S2 定案）

- **HTTP 面唯一持有者 = `bridge/api.py`**，且**它就是进程入口**（`python3 -m bridge.api`）。对齐决策人 whale-moe 的 `bridge/control_api.py` 章（一台轻服务器 = 静态资源 + JSON API）。**原 v2.2 的 `core/server.py` 已从树中删除**——它会造成 `core→bridge` 违规边（ADR-010）。`core/registry.py` 仍是被 bridge 调用的装载器。
- **MANIFEST 不再声明 routes**（撤回 v2.1 §10.C#2 的「注册路由」表述），模块只声明回调 `rpc[]`（函数名清单）；bridge 统一以 **`/m/<module>/<rpc>`** 挂载；**bridge 自有端点恰好五个**：`/api/state`、`/api/judge`、`/api/daily`、**`/api/kp`**、**`/api/attempts`**（⚠️ 原「固定四个」为笔误；§1 图中的 `/api/questions` 是**离线打包路径**，非运行时端点——已修正）。
- **引导端点 `/setup` 是唯一不过凭据门的入口**（v2.7 补，回应复核 B2；**v2.15 措辞对齐**：门里现在有两种凭据）：它就是「换取凭证」的入口，若也过门则永远拿不到 cookie（部署死锁）。它只受 §13.3 的独立限速，不参与统一过滤器；上一句的「恰好五个」专指 `/api/*` 自有端点，**不含 `/setup`**。
- **安全后果（质检官警告的正解）**：全部 `/m/*` 与 `/api/*` 经 **bridge 单点凭据门 + rate-limit**（凭据 = 浏览器会话 cookie **或** 服务间 Bearer，二者互不可替代；**加鉴权路径不加端点**，见 ADR-015 决策 3）——test_api.py 现在可以写了（单一过滤器；**唯一例外见上一条**）。

### 11.6 文档卫生定案（S3 中三条 + 一行级全收）

| 项 | 定案 |
|---|---|
| §2 双真相源 | 已加 SUPERSEDED 横幅（见 §2 顶部） |
| 模块自测位置互斥 | 定案：**`modules/<name>/tests/`**（同目录法）；registry 扫描时跳过 tests/ 与 docs/；`tests/` 顶层只放跨块契约测试 |
| events 执法挂点 | 定案：`contracts/events.py`（枚举）为唯一真值 + `events.md` 仅人话注解；事件改名走 `test_dep_rules.py` 红灯（拼错=导入点不存在=红） |
| 日期 | 统一纠正为 2026-09-17（v2/v2.1/v2.2） |
| 解释器矩阵 | **目标**：服务器 3.12.3（部署面）；**开发**：3.12.13 / 3.14.7（CI 面）。骨架要求所有测试在两栏解释器下双绿（质检官已在 3.12.13 首证，我方补 3.14.7 存量真值 = 30 断言） |
| 「个险 duration」 | 已改：「state / due 算术 / picker / migrate 四件套」 |
| whale-moe 双副本 | 实测**仅一副本**（`math-practice-survey/clones/whale-moe`，mtime 09-17 16:18，207 文件）；`_whale-moe-ref` 在本环境不存在（或为质检者自身环境的另名副本）——锚点以本路径为准，其它环境副本不作证据 |
| 30/1,320 断言精度 | 采纳质检官口径：「30 是 check() 调用点（自建断言器），聚合循环实跑 ≈1,320 组随机样本」——比「30 项断言」更精确，文档措辞升级 |

### 11.7 质检官「无法判断」三条的闭环记录

| 项 | 质检管状态 | 我方闭环 |
|---|---|---|
| 服务器 3.12.3 | 登不了机 | **SSH 实跑三连**：3.12.3 ✓ / tomllib ✓ / yaml 存在（但纪律不用） |
| 评审原文转录忠实度（含 10/10 复验表） | 不可读 | 原件在 `adaptive-practice-survey/评审对齐-执行清单v2.md`（§A 复验记录表）——按需开放读取权限即可 |
| 🧩 节「三重接线」细节 | 只核到标题 | 我方当时的阅读证据：README.md「开发：加一个小组件」节原文——「一个小组件就是一个文件…自动获得：语音工具（LLM 可调用）+ Web 面板卡片 + 桌宠联动」——内容级为真，非粉饰 |

### 11.8 对「暂缓立骨架」的响应

**同意暂缓，且与决策人「规划期不写代码」的指令同向。** P1/P2/P3 的三个答案（§11.1-11.3）已把目录形状的三个变数钉死；**§11.9 真值树**（＝§10.B + 本节五处修正的合并结果）可以作为**唯一真值树**被质检官依其承诺复跑全契约一致性。质检官内建「第二意见 agent」可选——建议待 v2.2 复核时若有分歧，再一并挂。


### 11.9 v2.5 真值树（唯一可执行目录树 —— 回应复核 B1）

> 背景：v2.2 只写了「§10.B + 五处修正」的**增量描述**，从未落成一张合并后的树，导致 T0 的验收标准不可执行。
> 本节即**合并后的唯一真值树**；§10.B（v2.1 树）与 §2（旧树）均自此降级为演进留档。

```text
math-drill/                        # 仓库根（落盘路径见 IMPLEMENTATION_BRIEF §0.6）
├── core/                          # 命脉，极薄；不含 HTTP（被 bridge 调用）
│   ├── registry.py                # 清单扫描与装载（★ 全仓唯一的动态装载点，豁免见 §11.4.1）
│   ├── store.py                   # blob 读写 + 版本仲裁（ADR-002）；**建表与 `schema_version` 迁移的唯一归属**（铁律 3：持久层在 core，模块不建表——v2.8 回应清单③）
│                                  #   四张业务表 = questions / kp / attempts / **agent_notes**（agent 复盘，ADR-017；只读暴露，无写端点）
│   ├── judge.py                   # fail-closed 判定器（ADR-003 / JUDGE_CONTRACT）
│   └── exact/                     # ★ 第 5 命脉：精确算术（原型 drill/exact.py 迁入；T0.5 执行）
│       ├── __init__.py            # ★ 导出面：`from core.exact import det, rank, rref, ...`（P1 钦定的调用形式；v2.8 实测：无此文件该 import 报 ImportError）
│       ├── exact.py
│       └── README.md
├── bridge/
│   └── api.py                     # ★ 进程入口（python3 -m bridge.api）：HTTP 唯一持有者
│                                  #   （凭据门 + rate-limit + 挂载 /m/* 与**五个** /api/*；v2.15 措辞对齐、v2.20 更正"三个"这个陈旧计数）
│                                  #   ⚠️ 模块路由入参 = JSON body ⊕ 查询串（ADR-017 决策 6）
├── modules/                       # 一切功能：每处 = manifest.json + module.py + [page.html] + README.md + tests/
│   ├── practice/                  # [P1] 答题会话
│   ├── daily/                     # [P1] 每日任务单
│   ├── gamifier/                  # [P1] 游戏化（承接 game.js 配置）
│   ├── review/                    # [P2a] SM-2 + kp_state 迁移
│   ├── picker/                    # [P2b] 时间衰减选题（测试先行）
│   ├── report/                    # [P3] 周度薄弱报告
│   ├── vault_export/              # [P3] 错题 → Obsidian vault
│   ├── explain_llm/               # [P5] 讲解通道（客户端直连，服务端零代理）
│   ├── classroom/                 # [P5] enabled=false（D3）
│   └── qbank/                     # [P1·ADR-017] 题库浏览（栏目/题卡/详情）：rpc = list/detail，**只读聚合**
│                                  #   questions+attempts+agent_notes+kp；**不加端点**（只走 /m/qbank/*）。P3 原定的融合/订正链仍未做
├── generators/                    # 题源插件：每处 = manifest.json + 生成逻辑 + README.md + tests/
│   ├── linalg_det/                # [P1] 线代 Ch1 行列式（Phase 1 唯一题源，见 T6/M6）
│   ├── linalg_mat/ … linalg_quad/ # [P4] Ch2-Ch6 —— Phase 1 **不预建**这些目录（T0 只建已列出的 linalg_det / custom_json / textbook_import），P4 按需新增（v2.8 消解省略号歧义）
│   ├── custom_json/               # 外部题源（兼容基底 customQ 格式）
│   └── textbook_import/           # [远期]
├── contracts/                     # 跨域契约真值（数据叶，五域只读依赖；自身零依赖）
│   ├── answer_types.py            # answer_type 枚举（JUDGE_CONTRACT §2 的机器可读化）
│   ├── events.py                  # 事件名枚举（唯一真值）
│   ├── dep_matrix.toml            # 6×6 允许依赖矩阵（test_dep_rules 读它执法）
│   └── blob_merge.md              # blob 合并规则真值（ADR-002/007）
├── config/
│   ├── modules.toml               # 启停表（tomllib 只读；全仓禁 YAML）
│   ├── server.toml                # ★ 运行时常量真值（§13.1：绑定/端口/cookie TTL/限速/data_dir/τ）
│   └── server.example.toml        # 对照样例（随仓提交；**不含任何凭据**）
├── web/                           # ★ 静态根（bridge 只服务这个目录，见 §13.2）
│   ├── index.html                 # ★ 入口页（fork 的 index.html；T4 在此加同步状态、隐藏 classroom 入口）
│   ├── js/                        # fork 的 js（app.js/engine.js/…）+ ★ api.js（唯一新增接线：存储桥 + judge 客户端 + qbank 客户端）
│   │                              #   + ★ qbank.js（题库栏目/题卡/详情页；渲染借 app.js 的 MDShell，不许自己发 HTTP；ADR-017）
│   ├── assets/                    # css / 图标 / 字体
│   └── tests/                     # node 测试落点（D6；run-all.js 按 __dirname 扫描 test-*.js）
│                                  #   ⚠️ bridge 必须拒绝暴露 web/tests/** 与 dotfile
├── tests/                         # 跨域与内核测试（unittest）
│   ├── test_exact.py              # 原型迁移后落此（T0.5）
│   ├── test_judge.py              # [T1] 10 例回归 + 6 例边界 + 性质测试
│   ├── test_store.py  test_api.py # [T2/T3]
│   ├── test_dep_rules.py          # [T0] 依赖纪律 §11.4.1 三项检查
│   ├── test_registry.py           # [T3] MANIFEST 校验与装载（被测对象 `core/registry.py` 是 T3 产出；T0 建骨架，v2.9 改标——原标 [T0] 会造成"越界/空壳/红"三解）
│   └── test_picker.py             # [P2b 先写]
├── scripts/                       # gen_bundles.py（打包 bundle）· db_init.py（**建表 + schema_version + 灌 bundle**，T7 部署前置）· backup_check.sh · refcheck.py（**文档自洽护栏，规格见 §14**）
├── deploy/                        # math-drill.service / caddy.block / backup.timer + backup.service（timer 必须配对 oneshot）/ logrotate.d/math-drill（**必须 copytruncate**，见 §12.1 注①）
├── docs/                          # ARCHITECTURE / JUDGE_CONTRACT / BOUNDARY / DATA_PIPELINE
│                                  #   / MODULE_TEMPLATE / IMPLEMENTATION_BRIEF / DECISIONS
├── data/                          # 运行时数据（.gitignore：data/、*.db、*.db-wal）
├── references/                    # 调研/对拍留档（含版权样本）——**.gitignore 排除，不入版本控制**（与 data/ 同待遇，v2.8 消解与 H8「版权数据零入仓」的冲突；不进仓库即不进远端）
├── patches/                       # fork 上游补丁留痕（ADR-006 / §10.1；Phase 1 为空占位目录）
├── dsh/                           # ★ DSH 插件集宿主层（**ADR-015**）：客户端插件（UI 槽位）+ 桥接插件（数据/工具）
│   ├── README.md                  #   目录定位、安装/凭据步骤、分期（Phase A/B 均已落地）、已知限制
│   ├── 参考-官方文档与生态.md      #   官方 Skill/文档 + 社区对标物 + 逐条对照（2026-09-20 调研，含素材哈希清单）
│   └── math-drill-plugin/         #   桥接插件（宿主半边 + 客户端半边）：只读数据通路 + 两个 agent 工具 + 状态条
│       ├── package.json           #   `dsh.bundle.patch` 声明 ⇒ `dsh plugin add` 自动进 profile 的 bundles
│       ├── cordis.patch.yml       #   bundle 补丁：只 `insert` 一行（不放凭据值，只有路径/环境变量名）
│       ├── src/index.js           #   cordis 插件（宿主半边）：name / inject / Config / apply + 只读状态路由
│       ├── src/shared/contract.js #   ★ 两半**共用契约**（STATE_PATH / STATE_SCHEMA_VERSION / isStateResponse）
│       │                          #     相对 import ⇒ 被 tsdown 内联，不落 require 表（评审 Z1 的正解）
│       ├── src/credential.js      #   服务间凭据读取（0600 校验；**永不打印**）
│       ├── src/math-drill-api.js  #   只读 HTTP 客户端（只有 GET /api/state、/api/daily —— 无写方法）
│       ├── src/client/index.ts    #   客户端半边（浏览器）：注册 conversation.input.dock（list 型，追加）
│       ├── build/web-platform.ts  #   平台模块表（loader 的 require 只能解析表内模块；镜像自生态预设）
│       ├── tsdown.config.ts       #   客户端产物构建（镜像官方 clientConfig；产物 = __ModuleLoader__ 包装）
│       ├── tools/build-client.mjs #   `pnpm build` 的壳：调用本机已有的 tsdown（不联网装）
│       ├── lib/client.js          #   ★ 构建产物（入仓：link: 安装直接用它；改了 src/client 必须重跑 build）
│       ├── src/summarize.js       #   纯函数核（无 harness 依赖 ⇒ 仓库内可直接测）
│       ├── src/tools.js           #   `defineTool` 接线层
│       ├── tools/link-dsh-deps.mjs #  把 `@deepseek-ai/*` 链到本机 DSH（`link:` 装的插件必须自带可解析依赖）
│       └── tests/                 #   node --test（当前 **28** 条：凭据纪律 / wire 行为 / 红线 / 接线 / 产物形状 / 产物运行时；条数以实跑为准）
│                                  #   ⚠️ 目录已创建（v2.16）；refcheck 的 TOP_DOMAINS 已补 `dsh`（v2.16，机械护栏就位）
├── README.md  LICENSE  ATTRIBUTION  THIRD_PARTY_NOTICES.md  .gitignore
```

**树的三条纪律**（施工时不得自行增删顶层域）：
1. 顶层域固定为 `core / bridge / modules / generators / contracts / config / web / **dsh** / tests / scripts / deploy / docs / data / references / patches` + 若干仓库文件（v2.8 补 `data/`——它在树里但原清单漏列；**`dsh/` 由 ADR-015 新增**，是本清单唯一新增的顶层域，且**仅此一次**——新增它用的是 ADR 这条合法通道）。
2. 新增功能一律落在 `modules/`；新增题源一律落在 `generators/`；**不得新增顶层域**。
3. `web/tests/` 是 node 测试的唯一落点（`run-all.js` 用 `__dirname` 扫描，搬迁必须整目录）。

**上游 pin（v2.7 补，回应复核 C-2）**：`web/` 的内容来自 fork **`111wukong/kaoyan-math-tutor`（MIT）@ `82c014479f712a88b43fc147ab92d824c0ccc784`（master, 2026-09-14）**。
T5 的「511 项全绿」基线即该 commit 的实测值（复核者本机复跑：工作区洁净、`node tests/run-all.js` → 511 项全通过）。
clone 后删 `.git`（上游以 `ATTRIBUTION` 声明，见 `IMPLEMENTATION_BRIEF §0.6`）；**上游漂移不自动跟随**——升级 commit 须更新 `ATTRIBUTION` 并重跑 T5。


---

## 12.（v2.5 追加）部署规格（回应复核 B6：T7 原先指向不存在的 §3.6）

> 目标主机：腾讯云轻量 `101.43.18.37`（Ubuntu 24.04 / 4C / 3.6G / 27G 可用 / Python 3.12.3 实测）
> 前提：该主机已有 Caddy(Docker) + CouchDB + dsh-web 在跑 —— **本项目的部署只允许「追加」，不得改动既有服务**

### 12.1 systemd 单元（`deploy/math-drill.service`）

| 字段 | 值 | 理由 |
|---|---|---|
| `User` / `Group` | `math-drill`（专用系统用户，非 root、非 reader） | 最小权限 |
| `WorkingDirectory` | `/opt/math-drill` | 与既有项目分离 |
| `ExecStart` | `/usr/bin/python3 -m bridge.api` | ★ 入口 = bridge（ADR-010）。**不带绑定类参数**——绑定/端口只有 `config/server.toml` 一个真源（v2.8 回应复核阻塞1；原写 `--host 127.0.0.1 --port 8081` 与 §13.1 构成双源） |
| `Environment` | `PYTHONUNBUFFERED=1`、`MATH_DRILL_TOKEN_FILE=/etc/math-drill/token` | 日志实时；**token 路径必须在此注入**（缺失/空 → 拒启，见 §13.1/§13.3②）。数据目录**不用 env**——单源在 `config/server.toml` 的 `data_dir`（v2.7，回应 B3a/B3c） |
| `Restart` / `RestartSec` | `on-failure` / `5` | 对齐既有 `dsh-web.service` 习惯 |
| `NoNewPrivileges` | `true` | 对齐既有服务加固 |
| `PrivateTmp` | `true` | 同上 |
| `ProtectSystem` / `ReadWritePaths` | `strict` / `/var/lib/math-drill` | 只允许写数据目录 |
| `StateDirectory` | `math-drill` | systemd 自动创建 `/var/lib/math-drill`（属主与权限正确）并从 `ProtectSystem` 效果中豁免——**不要手工 `mkdir`**（v2.7 补，回应 B3d） |
| `StandardOutput`/`Error` | `append:/var/log/math-drill.log` | 单文件日志；**必须同时部署 logrotate 片段**（否则无限增长）。与 `ProtectSystem=strict` 不冲突，理由见注①。⚠️ 该片段**必须用 `copytruncate`**（或轮转后重启服务）：日志是 fd 继承写入，默认 `create` 式轮转会让进程继续写已改名的旧 inode，**新日志静默不增长**（v2.8 补，回应清单⑧） |

**强制**：只绑 `127.0.0.1:8081`，**绝不绑 `0.0.0.0`**（公网面只由 Caddy 提供）。

> **注①（v2.7，复核实测澄清——驳回复核 B3b）**：`append:` 指定的日志文件**由 PID 1（service manager）在单元命名空间之外打开**，因此 `ProtectSystem=strict` **不影响**它。依据 `man 5 systemd.exec` 原文："the target path is opened by the service manager before the executable is invoked … The resulting descriptor is then inherited … into the unit's own domain."
> 该结论成立的前提是**日志只经 stdout/stderr 走 fd 继承**；若将来应用自行 `open()` 写日志文件，才需要 `LogsDirectory=math-drill`（该设置会自动从 `ProtectSystem` 效果中豁免）或把路径加进 `ReadWritePaths=`。
> **注②**：`data_dir` 单源在 `config/server.toml`；systemd **不再**注入 `MATH_DRILL_DATA`（v2.6 的双源于 v2.7 消除）。

### 12.2 Caddy 站点块（`deploy/caddy.block`，**追加**到 `/root/obsidian-livesync/Caddyfile`）

按既有文件同构写法。**实测（2026-09-17，复核者登机只读核查）**：Caddy 是 **Docker 容器 `caddy-for-ols`**（compose 服务名 `caddy`，镜像 `caddy-cloudflare:2.11.4`；宿主**没有** caddy systemd 单元，`systemctl is-active caddy` = inactive）；Caddyfile 确在 `/root/obsidian-livesync/Caddyfile`；既有两块是 `obsidian.zhu2006.xyz`（纯 `reverse_proxy`，**无 `tls` 块**）与 `reader.zhu2006.xyz`（**有** `tls { dns cloudflare {env.CLOUDFLARE_API_TOKEN} }`）。⇒ **math 块照 `reader.*` 写，别照 `obsidian.*`**（原文"同用 DNS-01"只对了一半）：

```
math.zhu2006.xyz {
    tls {
        dns cloudflare {env.CLOUDFLARE_API_TOKEN}
    }
    reverse_proxy 127.0.0.1:8081
}
```

**操作纪律**：① 改前 `cp Caddyfile Caddyfile.bak-<date>` **并记录原文件 `sha256sum`**（用于回滚校验，见 §12.4⑩）（该目录已 git 化，改动可回滚）② 只追加，不动 `obsidian.*` / `reader.*` 两块 ③ **先 validate 再 reload**：`docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile` 绿了，才执行 `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile` ④ **只准**上面的 `caddy reload` 或 `docker restart <caddy 容器名>`；**禁止 `docker compose up -d` / `docker compose restart` 一类全栈操作**（可能连带重建 CouchDB / dsh-web 容器，直接违反「不得改动既有服务」）⑤ 失败立刻回滚备份。
**DNS（决策人手动）**：Cloudflare 加 `math.zhu2006.xyz` A 记录 → `101.43.18.37`，**DNS only（灰云）**（与既有规范一致，避免 CF 代理干扰）。

### 12.3 备份与自检（`deploy/backup.timer` → `deploy/backup.service` → `scripts/backup_check.sh`）

> 注（v2.10 实测补）：systemd 的 timer **必须**有配对的 service 单元，故 deploy/ 下是 4 个文件
> （timer 只是触发器）。本地已实测：生成 → `integrity_check` ok → 轮转保留 N 份 → 用备份恢复可查。
> `/var/backups/math-drill/` 需可写（`backup.service` 的 `ReadWritePaths`），数据目录只读即可。

| 项 | 规格 |
|---|---|
| 频率 | 每日一次（避开整点） |
| 动作 | **在线备份到 `/var/backups/math-drill/` + `PRAGMA integrity_check`**（实现用 Python stdlib `sqlite3.Connection.backup()`——见下方 v2.11 实测注，**目标机没有 `sqlite3` 命令行**） |
| 保留 | 最近 7 份（轮转） |
| 失败处理 | 退出码非 0 写日志（**不做告警推送**——决策人明确不要推送类功能） |

> **v2.11 部署实测补两条（都是"照文档做会撞上"的坑）**：
> ① **目标机没有 `sqlite3` CLI**（2026-09-17 实测 `command not found`）——故 `backup_check.sh` 改用
>   Python 标准库的 `Connection.backup()`（就是 SQLite 官方在线备份 API，不是自造）；好处是不用往服务器装任何包。
> ② **`ReadWritePaths=` 指向的路径必须已存在**，否则 systemd 的 mount 命名空间直接失败
>   （实测报错 `Failed to set up mount namespacing: /var/backups/math-drill: No such file or directory`，`status=226/NAMESPACE`）。
>   故：`backup.service` 里该路径写成 **`-/var/backups/math-drill`**（不存在时不致命），
>   且部署时先 `install -d -m 750 -o math-drill -g math-drill /var/backups/math-drill`。

### 12.4 部署验收（T7 的执行标准）

```
① systemctl status math-drill → active (running)（若此处就失败：先查 §12.1 注②与 `MATH_DRILL_TOKEN_FILE` 是否注入）
② curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8081/api/state → 401（**无任何凭据**被拒，证凭据门生效；v2.15 补第二种凭据后，这条断言的值没变）
③ `/setup` 连续 4 次错误 token → 429（独立限速生效；语义见 §13.1 尾注）
④ 经 `/setup?t=<token>` 拿到 cookie 后访问 → 200；手机浏览器打开 https://math.zhu2006.xyz → 做题 2 道
⑤ 服务端：attempts 出现 2 行；systemctl restart → 数据仍在**且 cookie 仍有效**（派生式会话，重启不掉登录）
⑥ 静态暴露面正确：`/tests/run-all.js` 与任一 dotfile → 均 403
⑦ DNS：`dig +short math.zhu2006.xyz` → `101.43.18.37`（A 记录由决策人手动添加）
⑧ **Caddy 改动可证伪**：`git diff` 显示 Caddyfile 为**纯追加**（0 删行、0 改行）——只多出一个站点块
⑨ **既有服务未受影响**：`https://obsidian.<域名>/_up` 与 `https://reader.<域名>/` 各一次 `curl -s -o /dev/null -w '%{http_code}'` → 均 200（**必须走 https 公网面，不许只打本地端口或 http**）
⑩ 回滚可证：改前记录的 Caddyfile `sha256sum` 与备份文件一致（未回滚时以 ⑧ 的 diff 作为"只追加"证据）
⑪ 备份链路：`systemctl list-timers` 对照（既有 timer 未变）+ 手动触发一次 `backup_check.sh` → 退出码 0 且 `/var/backups/math-drill/` 出现新文件
⑪b 日志轮转生效：`logrotate -d /etc/logrotate.d/math-drill` 干跑无错，且片段含 **`copytruncate`**；轮转一次后新日志仍在增长（`ls -l` 前后对比，v2.8 补清单⑧）
⑫ 证据留档：上述全部命令输出
```


---

## 13.（v2.6 追加）配置与凭据落点（回应复核第二轮「新缺口 1/2」）

> 背景：v1 树里的 `server/config.py` 随树废弃后无人接替，导致「τ 默认 10 天(config)」悬空；
> 且 token 的**签发与存放全仓无定义**，而 H7 禁止入仓、T3 与 §12.4② 又都要求 token 门生效——
> 执行方到 T3 只能自行发明，属设计层决定，故在此定案。

### 13.1 常量与凭据的分家

| 类别 | 落点 | 是否入仓 | 说明 |
|---|---|---|---|
| **运行时常量**（绑定地址/端口、cookie 名与 TTL、限速参数、数据目录、τ） | **`config/server.toml`** | ✅ **随仓库提交**（非机密） | 由 `bridge/api.py` 启动时读取（tomllib）；另备 `config/server.example.toml` 供对照。**绑定类参数无 CLI / env 覆盖**（单源：`bind_host` / `port` / `data_dir` 一律以 toml 为准；systemd 单元不带参数，见 §12.1） |
| **访问 token** | **`/etc/math-drill/token`**（`chmod 600`，属主 `math-drill`） | ⛔ **绝不入仓**（H7） | 路径经 systemd `Environment=MATH_DRILL_TOKEN_FILE=...` 注入；**文件缺失或为空 → 进程拒绝启动**（不设默认 token） |
| **LLM key** | 客户端 localStorage（用户自持） | ⛔ 绝不入仓 | 服务端不代理、不存储（`explain_llm` 红线） |

`config/server.toml` 字段（契约，实现按此读）：

```toml
[server]
bind_host = "127.0.0.1"          # 绝不改 0.0.0.0
port = 8081
static_root = "web"               # §13.2
data_dir = "/var/lib/math-drill"  # 部署态；开发态就改本文件这一行（**无 env / CLI 覆盖**，见 §13.1 单源口径——v2.9 消歧）

[auth]
cookie_name = "md_session"
cookie_ttl_days = 365
token_file_env = "MATH_DRILL_TOKEN_FILE"

[ratelimit]
api_per_minute = 60          # /api/* 与 /m/*：每**桶**每分钟允许次数；桶键见下方语义注①（整数）
setup_max_failures = 3       # /setup：窗口内允许的**失败**次数（整数，不用 "3/hour" 这类字符串）
setup_window_seconds = 3600  # 固定窗口长度

[picker]
tau_days = 10                     # 回应复核 M/D5：τ 的落点在此，非缺失的 server/config.py
```

> **限速语义（v2.7 补 / v2.8 按端点分域，回应复核 C-1 与清单⑥；v2.14 改计数键 / v2.15 落地 / v2.17 上生产）**：① 计数键 = **按身份分桶**（v2.14 定，v2.15 落地）：**浏览器会话与未鉴权请求 → 来源 IP**；**服务间凭据（Bearer）→ 凭据哈希桶**（`agent:<sha256[:16]>`，桶表内不存凭据原文）。N=1 单用户，不做全局计数。⚠️ **落地状态（v2.17 更新：已上生产并实测）**：**仓库与生产机都已生效** —— `bridge/api.py` 有 `identity()` / `bucket_key()` / `bearer_of()` / `agent_value()`，`hit_api` 形参已由 `ip` 改 `bucket`，唯一调用点 `:321` 改传 `bucket_key(self)`，`/setup` 三个调用点**仍按 IP**（鉴权前的引导入口）；验收 12 条在 `tests/test_api.py` 全绿，另在**生产机**上实测七项：匿名 `/api/state` 401、正确 Bearer 200 **且响应不含 `Set-Cookie`**、cookie 值当 Bearer 401、Bearer 值当 cookie 401、真 cookie 200 且仍带 `Set-Cookie`（滑动续期未受影响）、`/api/daily` 匿名 401 / Bearer 200；静态面与公网入口（`https://math.zhu2006.xyz/` → 200、`/tests/run-all.js` → 403）**零影响**。⚠️ **v2.14 登记的实测依据（仍成立）**：部署态下 bridge 只监听 `127.0.0.1`、其后是 Caddy 反代且实现**未读** `X-Forwarded-For` ⇒ `client_address` 恒为回环地址，**原先的"来源 IP"档实际退化为单一全局桶**（实测 `/var/log/math-drill.log` 全文请求行来源均为 `127.0.0.1`）——这是"分桶维度必须换"的实证，不只是优化。② 窗口 = 固定窗口 ③ **`/setup` 只计失败**——成功即清零，故窗口内第 4 次即使携带正确 token 也不会被拒（否则 NAT 邻居连坐、合法用户被自己锁死）④ 而 **`/api/*` 与 `/m/*` 的 `api_per_minute` 计的是全部请求**（不论成败）——这不是互斥而是分域：前者防爆破、后者防滥用 ⑤ 命中 429 后窗口内不再放行 ⑥ 进程重启清零（N=1 可接受，且不会造成锁死）⑦ 参数统一为整数 + 秒。

### 13.2 静态根与暴露面

| 路径 | 归属 | 规则 |
|---|---|---|
| `web/` | **静态根**（唯一） | bridge 只从此目录提供静态文件 |
| `web/index.html` | 入口页 | `GET /` → 该文件 |
| `web/js/**`、`web/assets/**` | 前端资源 | 直接映射（`/js/...`、`/assets/...`） |
| `web/tests/**` | node 测试 | ⛔ **禁止对外暴露**（403）；同时对任何 dotfile 一律 403 |
| `/api/state`、`/api/judge`、`/api/daily`、`/api/kp`、`/api/attempts` | bridge 自有端点（五个；只读两个见 ADR-016） | 经**凭据门**（浏览器 cookie **或** 服务间 Bearer）+ 限速（桶键按身份，见 §13.1 注①） |
| `/m/<module>/<rpc>` | 模块 RPC（bridge 统一挂载） | 同上，无例外面 |
| `/setup` | 一次性凭据入口 | ⚠️ **不过 token 门**（唯一例外——它就是换取凭证的入口）；见 §13.3，**独立限速** |

### 13.3 Token 的签发、下发与轮换（T3/T7 的执行依据）

```
① 生成（部署时，一次）：openssl rand -hex 32 > /etc/math-drill/token
                          chown math-drill:math-drill /etc/math-drill/token && chmod 600 该文件
② 启动：systemd 注入 MATH_DRILL_TOKEN_FILE=/etc/math-drill/token → bridge 读取；缺失/空 → 拒绝启动
③ 下发（客户端，一次）：浏览器打开 https://math.zhu2006.xyz/setup?t=<token>
                        → 服务端 hmac.compare_digest 常数时间比对 token
                        → 成功则 Set-Cookie: md_session=<派生会话值>; HttpOnly; Secure; SameSite=Strict; Max-Age=365d
                          【派生会话值 = HMAC-SHA256(key=token, msg="md-session-v1")；其后每个请求由服务端重算并 compare_digest 校验】
                        → 302 跳转 /  ；失败仅返回 401（不回显任何信息）
④ 轮换：重新 ①，然后各设备重走 ③（token 变 ⇒ 派生值变 ⇒ **旧 cookie 自动失效**）
⑤ 纪律：token 只出现在 ① 的本地命令与 ③ 的浏览器地址栏（一次性）；**不得写入任何文件、日志、git**
        服务端日志对 `/setup` 只记「成功/失败 + 来源 IP」，**不记 token 值**  ← ⚠️ v2.14 实测：此承诺现实现未做到，见下注
```

> ⚠️ **v2.14 实测更正（既存缺陷，如实登记，不在本次修）**：
> ① **请求行整条进了日志（含 query 串）** —— `bridge/api.py:251-252` 把 `log_message(fmt, *args)` 的 `fmt % args` 原样写 stderr，而 `BaseHTTPRequestHandler` 传进来的 args 里含 `self.path`；`deploy/math-drill.service:41-42` 又把 stderr `append:` 到 `/var/log/math-drill.log`。实测 `grep -c "GET /setup?t=" /var/log/math-drill.log` = **10** ⇒ **主 token 已明文落盘 10 次**，上句「不记 token 值」被现有实现打破。
> ② **文件权限 0644**（实测 `stat`：`644 math-drill:math-drill 14354`）—— service 未设 `LogFileMode=`，重建后仍是默认位。
> ③ **`来源 IP` 这一半在部署态没有信息量**：实测全文 290 行请求行来源**均为 `127.0.0.1`**（Caddy 反代在后、实现未读 `X-Forwarded-For`）。
> ④ ⚠️ **同一实测在 `/setup` 上是反向后果（v2.14 追加，回应 Bearer 规格第三轮评审 N2）**：`/setup` 的失败计数也走 `client_address[0]`（`:297`/`:302`/`:306`），判据是 `fails >= setup_max_failures`（`bridge/api.py:123`，现值 3 / 3600s）⇒ **部署态这个键也是同一个回环地址 ⇒ 任何人 3 次带错 `?t=` 的请求，就把 `/setup` 对所有人锁一小时（含运营者自己）**；窗口内除重启服务**无法自救**（正确 token 也被 429 挡在门外 —— §13.1 注③ 的「成功即清零」要先过门才谈得上清零）。
> **此处"键不改"**（鉴权前的引导入口**必须**按 IP 防爆破），但**必须登记**：运营者须知「3 次错就等一小时，或重启服务」。候选修法（**未定案，须走 ADR**）：bridge 只监听回环 ⇒ 可安全采信 Caddy 注入的 `X-Forwarded-For` 首项作为键；或把 429 从静默改为带 `Retry-After`。
> **处置（待办，与 Bearer 施工同批或独立立项）**：请求行**不记 query**（直接消灭 ①）＋ 权限收紧到 **0640** 并显式设 `LogFileMode=` ③ 轮转产物权限同步核对。**在此之前，本行按"已知未修"读**，不得当作已实现的保证。

> **为什么是派生值而不是随机会话值（v2.7 定案，回应复核 B4）**：随机值要么存内存（重启即掉，且**轮换 token 不会使任何已发 cookie 失效**——④ 的安全性质不成立），要么落库（§3 无 sessions 表，新增表需走 ADR，与 ADR-007/铁律 3 的单源边界摩擦）。派生方案**零存储**：无表、无文件、重启不掉登录、轮换自动失效、可测（`hmac.compare_digest` 恒定时间）。N=1 单用户不需要按设备独立撤销；将来若要，再引入设备注册并写 ADR。

> **滑动续期（v2.12 补，回应决策人「不要老让我重新认证」）**：已鉴权的请求会**顺带重发一次 cookie**
> （`Max-Age` 从当下重新起算）。原因：浏览器对 cookie 寿命有硬顶（Chrome ≤ 400 天），
> 单方面调大 `cookie_ttl_days` 没用；而 token 本身**永不过期**（它就是个静态文件）。
> 两者合起来的实际效果 = **只要偶尔用一次，登录永不掉**；就算换了设备/清了 cookie，
> 把 `/setup?t=<token>` 存成书签点一下即可恢复——所以那条 URL 值得当"永久钥匙"收藏。

**验收（T3 可测）**：无 cookie 访问 `/api/state` → 401；`/setup` 连续 4 次失败 → 429；
带 cookie 访问 → 200；`GET /tests/run-all.js` → 403（静态暴露面正确）。

> **静态面是否过凭据门（v2.8 写死，回应清单⑤）**：**不过门**。静态面（`/`、`/js/*`、`/assets/*`、`web/index.html`）**匿名可读**——因为验收预期的是 **403**（路径规则）而不是 401（鉴权失败）；若静态面也过门，`/tests/run-all.js` 就该返回 401，验收条自相矛盾。次序定死：**先路径合法性（越权路径 → 403），后鉴权（`/api/*`、`/m/*` 无凭据 → 401）**。数据 API 与模块 RPC 一律要凭据 —— **v2.15 更正**：凭据有**两种**（浏览器会话 cookie / 服务间 Bearer），故原写「一律要 cookie」在 ADR-015 之后**不完整**；两者**互不可替代**，`/setup` 仍是唯一不过门的路由。
>
> **T3 测试如何注入凭据（v2.8 补，回应清单⑦）**：H7 禁止把 token 写进夹具，而「缺失/空 → 拒启」又要求 T3 实测失败路径。唯一合规解——测试在临时目录生成一次性 token 文件，用 monkeypatch 把 `MATH_DRILL_TOKEN_FILE` 指向它（夹具里只出现路径与桩值，不出现真实 token）。必须覆盖三条：**环境变量缺失 → 拒启；文件为空 → 拒启；token 不匹配 → 401**。

### 13.4 与其它约束的关系

- **H7 不变**：凭据零入仓——本节把「零入仓」落成**可执行的存放路径 + 注入方式**，而非仅禁令。
- **H1 不变**：读 TOML 用 stdlib `tomllib`（3.11+），dev 机 3.12.13/3.14.7 与服务器 3.12.3 均已实测可用。
- **fail-closed 一致**：token 缺失拒绝启动、`/setup` 失败不回显、静态目录越权一律 403——三处都是「无法证明合法即拒绝」。

---

## 14.（v2.9 追加）文档自洽护栏：`scripts/refcheck.py`（立项规格）

> 触发：四轮复核下来抓到的问题**没有一条是设计错**，全部是「改了 A 没回扫 B」——v2.6 两次、v2.7 两次、v2.8 两次，v2.9 这次是账本本身的数目自相矛盾。这类核对不该靠人眼，它是机械活。

### 14.1 三类检查（缺一即不算完成）

| 类 | 检查内容 | 抓什么 | 已知命中 |
|---|---|---|---|
| **C1 树 ↔ 契约双向映射** | **路径 token 的语法（v2.10 定死）**：反引号包裹 **且** 满足其一 —— (a) 以已知顶层域开头（`core/ bridge/ modules/ generators/ contracts/ config/ web/ tests/ scripts/ deploy/ docs/ data/ references/ patches/`，见 §11.9 纪律 1）(b) 仓库根文件（`README.md` / `LICENSE` / `ATTRIBUTION` / `THIRD_PARTY_NOTICES.md` / `.gitignore`）。每命中一条 ⇒ 必须在 §11.9 树里出现；反向：树里每个条目至少被引用一次 | 悬空引用 / 树外文件 | v2.6 `config/server.toml`；v2.8 `patches/`、`tests/test_registry.py` |
| **C2 同值多定义** | **单源清单**（`bind_host` / `port` / `data_dir` / token 路径 / `cookie_name` / `cookie_ttl_days` / 限速参数 / 表名 / `schema_version` / 上游 pin sha / **`tau_days`** / `/api/*` 端点集合 = **12 组**）的**合法定义域只有 3 处**：① §13.1 的表 ② §11.9 树的注释 ③ `config/server.toml` / `server.example.toml` 样本。域外出现 → 红；域内两处**数值不一致** → 红；toml 样本行必须带可正则标记 `# 单源：<key>`（把"优先级声明"变成能 grep 到的短语）。⚠️ **机械校验覆盖面（v2.28 如实标注）**：`scripts/refcheck.py` 的 `SINGLE_SOURCE_KEYS` 覆盖 **7 组**（`bind_host` / `port` / `data_dir` / `cookie_name` / `cookie_ttl_days` / 限速参数 / `tau_days`）；**另 5 组目前无机械校验**（**token 路径** / 表名 / `schema_version` / 上游 pin sha / **`/api/*` 端点集合**）—— **这 5 组全靠人工与 ADR 纪律**，其中端点集合另受 §14 的"两类检查"清单约束 | 双真源 | v2.6 `data_dir`；v2.8 端口；**v2.28 清单补 `tau_days`（11 → 12 组）并如实标注 5 组无校验**（原表声明与实现不符：`tau_days` 在 `SINGLE_SOURCE_KEYS` 里却不在本表） |
| **C3 文档自陈数字** | **声明式清单（v2.10 定死真值来源）**：① 「共 N 行」→ `wc -l docs/*.md` 合计 ② 「N 条清单 / N 项」→ 同批次 ADR 编号项计数（`DECISIONS.md` 对应小节）③ 测试基线 `511` → 在 fork 里实跑 `node web/tests/run-all.js` ④ 上游 pin sha → 在 fork 里 `git rev-parse HEAD` ⑤ 验收项数（§12.4 的 ①..⑫/⑪b）→ 逐条计数。任一不符 → 红 | 账本漂移 | v2.8「6 清单 vs 13 清单」；行数自陈 1724 vs 1744 |

**豁免表（C1 必须内置）**：§2、§10.B、§9 变更记录、ADR 背景段里的历史旧名（`qa` 表名、`server/config.py`、`web/pages`、`core/server.py`、`config/modules.yaml`）；**规划期路径 `linalg-drill/**`**（`IMPLEMENTATION_BRIEF` §0.6/§1 用它指代"现行位置"，T0 迁移后即不存在——v2.10 加入，否则首跑当天报红）；以及**宿主态路径白名单**——`/etc/math-drill/**`、`/opt/math-drill`、`/var/lib/math-drill`、`/var/log/math-drill.log`、`/var/backups/math-drill/`、`/root/obsidian-livesync/Caddyfile`（这些本就不在仓库树里，不豁免首跑会被几十条假红淹没，第二次就没人跑了）。

### 14.2 验收（T0 交付的一部分；负例优先）

```
① 正例：对当前 docs/ 跑出全绿（若红，先修文档再交付）
② 负例（必须，缺此不算交付）：
   fixture A：从树里删掉一个仍被引用的文件 → C1 必须红
   fixture B：同一单源值写两处且无优先级声明 → C2 必须红
   fixture C：把一个自陈数字改错（如 511 → 512）→ C3 必须红
③ 回归集：三类各至少回放一条历史案例（上表"已知命中"列）
```

> 依据：v2.8 清单⑬的教训——**不能红的 checker 比没有更糟**，它给的是假绿。

### 14.3 归属与调用时机

- **归属**：`scripts/refcheck.py`（树内条目）；契约出处 = 本节；验收 = §14.2；零依赖（stdlib，双解释器下可跑）
- **调用时机**：① 每次改完 `docs/` 之后 ② 每个 T 轮交付前（与 `tests/test_dep_rules.py` 同批）
- **自指要求**：本节与树行必须互为出处——否则它第一个抓到的就是它自己
