# 模块开发配方（MODULE TEMPLATE）

> 状态：设计冻结（规划期，无实现代码）· 依据 ADR-006 + ARCHITECTURE §10/§11
> 一句话：**加一个功能 = 加一个目录 + 启停表勾一行，内核零改动。**
> 本文件对标决策人 `whale-moe` 项目 README 的「🧩 开发：加一个小组件」节——那是本项目最喜欢的组织范式，故以同样姿势落地。

---

## 1. 一个模块长什么样

```
modules/<模块名>/                 # 目录名 = 模块名（全局唯一，小写下划线）
├── manifest.json                 # 声明单（registry 启动时校验）
├── module.py                     # 接线：注册回调（本文件是唯一的对外接缝）
├── page.html                     # 可选：本模块的 UI 面（若有前端）
├── README.md                     # 自述：做什么 / 数据流 / 边界 / 未做
└── tests/                        # 自测（registry 扫描时跳过）
    └── test_<模块名>.py
```

**四件套缺一不可**：清单（契约）、接线（逻辑）、自述（给人看）、自测（给未来看）。

---

## 2. MANIFEST 契约（`manifest.json` 字段表）

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `name` | ✅ | string | 全局唯一，须与目录名一致；registry 校验不一致即启动失败 |
| `phase` | ✅ | string | `"1" | "2a" | "2b" | "3" | "4" | "5"`——超出当前 Phase 的模块**不装载** |
| `enabled` | ✅ | bool | 启停开关（与 `config/modules.toml` 合并，后者优先） |
| `rpc` | 可选 | string[] | 本模块对外暴露的函数名清单（**不是路由**——路由由 bridge 统一挂 `/m/<模块名>/<rpc>`） |
| `blob_fields` | 可选 | string[] | 本模块读写的 blob 段名（ADR-007：**不声明表**，持久层只有 core 的 blob + 四张 sqlite 表） |
| `events_emit` | 可选 | string[] | 声明本模块发出的 registry 事件名（必须在 `contracts/events.py` 枚举内） |
| `deps` | 可选 | string[] | 只允许 `"core"` 与事件名；**禁止填其他模块名**（铁律 1） |
| `description` | ✅ | string | 一句话（会出现在启动日志与 `--modules` 列表里） |

**格式纪律**：JSON（stdlib `json` 解析）。**禁止 YAML**——理由见 ADR-005 附注（依赖环境随机产物）。人类注释写在模块 README，不塞清单。

---

## 3. 接线契约（`module.py` 必须实现的两个回调）

| 回调 | 何时被调用 | 签名（契约示意，非实现） | 不要它时 |
|---|---|---|---|
| `on_request` | 有 HTTP 请求命中 `/m/<本模块>/<rpc>` 时 | `(rpc_name, payload, ctx) -> dict` | 显式声明 `noop`（**不允许留空实现**——留空会静默吞请求） |
| `on_schedule` | core 的定时器触发本模块声明的任务时 | `(job_name, ctx) -> dict` | 同上 |

**ctx 提供的只有三样**（这就是模块能碰到的一切）：
1. 存储访问（blob 段读写 + 四张表的**受控视图**）
2. 判定器入口（`core.judge`，本模块不得自行实现判定）
3. 事件总线（发/收 `contracts/events.py` 枚举内的事件）

> **铁律 3 落地**：HTTP 服务、blob 持久化、判定仲裁都在 core，**不可插件化**。模块拿不到 socket、拿不到 sqlite 连接、拿不到密钥。

---

## 4. 加载生命周期（core/registry 做，模块不感知）

```
启动
 └─ 扫描 modules/*/manifest.json 与 generators/*/manifest.json
     ├─ 校验 name == 目录名                    （不一致 → 启动失败）
     ├─ 校验 phase ≤ 当前启用 Phase             （超出 → 跳过，日志记录）
     ├─ 合并 config/modules.toml 的 enabled     （表优先）
     ├─ 校验 deps ⊆ {core, events}              （违规 → 启动失败 = 铁律 1 的执行点）
     ├─ 校验 events_emit ⊆ contracts/events.py  （违规 → 启动失败 = 契约执法）
     └─ 装载：向 bridge 注册 rpc，向调度器注册 job
```

**没有任何「模块互相 import」的路径**——registry 也不会把别的模块交给它。

---

## 5. 加一个模块：七步清单（照抄即可）

```
1. mkdir modules/<名字>/
2. 写 manifest.json（§2 字段表，先只填 name/phase/enabled/description）
3. 写 module.py 的骨架：声明 on_request / on_schedule（用不到的那个写 noop 显式声明）
4. 写 README.md（§7 模板）
5. 写 tests/（§6 质量门）
6. 在 config/modules.toml 里加一行开关（默认值：新模块 = false，验证后再开）
7. 跑 tests/test_dep_rules.py 与 tests/test_registry.py → 全绿才算加完
```

**做完这七步，你不需要碰**：`core/*`、`bridge/*`、其他任何模块、`contracts/*`（除非本模块要新增事件——那时要走 §8 流程）。

---

## 6. 模块质量门（不达标不合入）

| 门 | 要求 |
|---|---|
| G1 清单合规 | registry 校验全过（名字/Phase/deps/events） |
| G2 自测存在 | `modules/<name>/tests/` 至少覆盖：正常路径、边界、以及**本模块声明拒绝的输入** |
| G3 依赖合规 | `test_dep_rules.py` 绿（无横向依赖、无 core 反向依赖） |
| G4 不做判定 | 不实现任何答案比对逻辑（一律调 `core.judge`）；`grep` 证据：本模块内无 `parseFloat`/`eval`/判定式比对 |
| G5 不碰密钥 | 不读写任何 key；LLM 一律走客户端通道（客户端持有 key） |
| G6 自述齐全 | README 含 §7 全部区块（含「未做/已知限制」） |
| G7 可回退 | 把 `enabled` 置 false 后系统完好（模块不得被 core 硬依赖） |

---

## 7. 模块 README 模板（区块清单）

```
# <模块名>

## 一句话
## 为什么需要它（对应哪条需求 N1-N7）
## 数据流（进什么 / 出什么 / 写哪些 blob 段）
## 对外接口（rpc 清单 + 每个 rpc 的入参出参）
## 依赖（core 的哪些能力 + 哪些事件）
## 未做 / 已知限制（诚实区，禁止留空）
## 验收方式（怎么证明它能用）
```

---

## 8. 需要动 contracts 时（新事件 / 新类型）

```
1. 先改 contracts/events.py（枚举）或 contracts/answer_types.py
2. 同步改对应测试（铁律：契约改动必须伴随测试变更，否则 test_contracts 红）
3. 更新 docs/JUDGE_CONTRACT.md 或 ARCHITECTURE 对应节
4. 若属架构级影响（新增域、改依赖矩阵）→ 写 ADR 再动手
```

---

## 9. 反面清单（Anti-patterns）——违反哪条铁律一目了然

| 反模式 | 违反 | 后果 |
|---|---|---|
| 模块 A `import` 模块 B 的逻辑 | 铁律 1 | `test_dep_rules` 红；架构退化成单体 |
| 模块自己 `CREATE TABLE` | ADR-007 | 单一真相源破碎（P3 质检结论） |
| 模块里写答案比对 | 铁律 3 / I1-I4 | 判定多源，出现第二个 fail-open 的地方 |
| 模块自己起 HTTP 端口 | 铁律 3 | 绕过 bridge 的 token 门与限速 |
| manifest 里填别的模块名到 deps | 铁律 1 | 启动即失败（设计如此） |
| 模块在 `on_request` 里留空实现 | 契约 | 静默吞请求，最难查的一类 bug |
| 把 LLM key 写进模块配置 | 红线 | 凭据泄漏（且违反服务端零代理原则） |
| 用 YAML 写清单 | ADR-005 | 部署环境随机炸 |

---

## 10. 首批模块的对应关系（照着做即可）

| 模块 | Phase | 关键接缝 | 备注 |
|---|---|---|---|
| `practice` | 1 | 调 `core.judge`；写 blob `daily` | 与 `web/` 答题 UI 配对 |
| `daily` | 1 | 首建锁定当日任务（`generated_at`） | 依赖 picker（Phase 1 先用基底启发式，P2b 换真实现） |
| `review` | 2a | SM-2 + `kp_state` 段迁移 | 含迁移器（blob 内纯函数键迁移） |
| `picker` | 2b | 带时间衰减的加权选题 | **先写 tests（六条性质）再实现** |
| `report` | 3 | 周度薄弱点聚合 | 只读 attempts + kp_state |
| `vault_export` | 3 | 错题 → Markdown（走决策人已有 vault 管道） | 出网到 Obsidian，不经服务端外发 |
| `explain_llm` | 5 | 客户端直连 LLM 的讲解通道 | 服务端零代理（红线） |
| `gamifier` | 1 | 继承 game.js 的 XP/成就设置 | 默认启用（习惯存活） |
| `qbank` | 3 | 题库查询 / 整合 / 溯源视图（**预留窗口**，现在 rpc 为空） | ⚠️ **不开第二端口**：走既有 bridge 的 `/m/qbank/*`；只读 questions + attempts，不写表、不判定 |
| `classroom` | 5 | **启用位 false** | 隐藏入口，代码保留 |
