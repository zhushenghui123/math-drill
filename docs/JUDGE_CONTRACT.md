# 判定契约（JUDGE CONTRACT）v1

> 状态：设计冻结（规划期，无实现代码）· 依据 ADR-003 + 外部评审根因 2 + 质检官复核
> 一句话：**判定是服务端确定性闭包，类型内判不了就承认判不了（fail-closed），永不猜、永不让 LLM 介入。**

---

## 0. 不变量（Invariants）——实现必须逐条守住

| # | 不变量 | 违反后果 |
|---|---|---|
| I1 | 判定只发生在服务端 `core/judge.py`；客户端只上传**原始输入字符串** | 客户端可篡改结论 |
| I2 | 判定链路中**无 LLM 调用**（含标注/清洗/纠错） | 数学对错被概率化 |
| I3 | **fail-closed**：无法证明相等 → 返回 `undecidable`，**不得回退猜测** | 假阳性（当前基底的实际病：`"1"` 对 `"1+sqrt(2)"` 判对） |
| I4 | 判定输入含 `answer_type`；**判定必须走声明类型的文法**，不得跨类型兜底 | 类型污染（如把矩阵当标量） |
| I5 | `attempts` 由 judge **独占写入**（append-only 事实源） | 双真相源（ADR-007 已立） |
| I6 | 自评（self_report）是**一等公民通道**，不是降级品 | 解答题无家可归 |

---

## 1. 接口契约

### 1.1 请求（客户端 → bridge `/api/judge`）

```
POST /api/judge
{
  "qid":      "linalg.det.3x3.a1b2c3",     // 题目稳定 id（内容寻址）
  "raw_answer": "  -3  ",                   // 用户原始输入，不预处理（归一化在服务端做）
  "user_ms":  41200,                        // 可选：用时
  "device":   "phone"                       // 可选：多端观察用
}
```

**`answer_type` 由服务端按 `qid` 从 `questions` 表取**——**客户端不传**（回应复核：I4/§4 要求类型驱动判定，
但 §1.1 请求体里没有该字段；现写明取法，避免执行方二义）。

### 1.2 响应（bridge → 客户端）

```
200 {
  "verdict":   "server_true" | "server_false" | "undecidable" | "self_reported",
  "correct":   true | false | null,          // null = 非判定通道
  "canonical": "-3",                        // 规范答案（undecidable / self_report 时也回传，供展示）
  "answer_type": "rational",
  "detail":    { "reason": "prefix-truncation-guard", "accepted_forms": ["-3","-3/1"] }
}
4xx { "error": "malformed_request" | "unknown_qid" | "type_mismatch", "message": "..." }
```

**关键点**：`canonical` 任何情况下都回传——即使判不了，用户也能看到答案并走自评（这是 fail-closed 的可用性补偿）。

---

## 2. 答案类型契约（answer_type）

| 类型 | 接受输入形态 | 规范型 canonical | 比较规则 | MVP |
|---|---|---|---|---|
| `rational` | `-3`、`-3/1`、`-1.5`、`-\frac{3}{2}`、全角数字 | 既约分数 `p/q`（整数时分母略） | **精确相等**（Fraction 判等），**禁止浮点容差**（容差是假阳性之门） | ✅ 主战场 |
| `vector` | `1 2 -3`、`(1,2,-3)`、`[1,2,-3]` | 分量数列 | 维度一致 + 逐分量 rational 判等 | ✅ |
| `matrix` | `1 2; 3 4`（行分号列空格） | 嵌套列表 | 行列数一致 + 逐元 rational 判等 | ✅ |
| `interval` | `(0,1)`、`[0,1)`、`(0,+∞)` | 端点对 + 开闭标记 | 端点判等 + 开闭一致 | 🔜 P4（概率章） |
| `set` | `{1,2,3}`、`1,2,3` | 去重升序集合 | 集合相等（**顺序无关**） | 🔜 P4 |
| `symbolic` | 任意表达式 | —— | **MVP 不支持自动判定** → 强制走 `self_report` | ⛔ 由 P4 评估 sympy 后再开 |
| `self_report` | 用户自评：`对 / 错` | —— | 不比对，仅记录 | ✅ 一等公民（解答题的通道） |

### 2.1 `integer` 的处理（定案）
不设独立类型，**并入 `rational`**（减少类型面；分数形态天然覆盖整数）。

### 2.2 归一化（norm）——保留与删除清单

| 动作 | 保留？ | 依据 |
|---|---|---|
| 全角→半角 | ✅ 保留 | 基底资产（中文输入必用） |
| 去空白 / 统一大小写 | ✅ | |
| `\frac{a}{b}` → `a/b`、去 LaTeX 反斜杠 | ✅ | |
| `π→pi`、`√→sqrt`、`²→^2`、`×→*` | ✅ | |
| 中文标点→英文 | ✅ | |
| **`parseFloat(u)` 前缀解析回退** | ❌ **删除（I3）** | 假阳性根源：`parseFloat("1+sqrt(2)")→1` |
| **`Math.abs(a-b) < 1e-6` 浮点容差** | ❌ **删除** | 同 I3：容差让「近似」冒充「相等」 |

> 归一化后的比较只走 **① 字符串精确相等** 与 **② 类型内规范型精确判等**；**不存在第三条路**。

---

## 3. fail-closed 决策树（实现照此写）

```
输入 raw_answer + answer_type
        │
        ├─ answer_type == self_report ────────────────→ 记录 self_reported（correct = 用户自选）
        │
        ├─ answer_type == symbolic ───────────────────→ MVP：强制 self_report（附提示「本题型暂不支持自动判分」）
        │
        └─ 其余类型：
             ① 归一化（norm）
             ② 按类型文法解析为规范型
                  ├─ 解析失败 ────────→ verdict=undecidable（reason=parse_failed）→ 客户端转自评
                  ├─ 形态过界 ────────→ verdict=undecidable（reason=type_mismatch）
                  └─ 解析成功 → 与 canonical 精确比较
                        ├─ 相等 → server_true
                        └─ 不等 → server_false
```

**`undecidable` 的 UX 契约**：客户端必须**立刻展示 canonical 答案 + 解析失败原因**，并给「对/错」自评按钮——用户不会因为系统判不了而卡住；同时该次录入 `verdict=undecidable`，进**数据侧勘误队列**（见 DATA_PIPELINE §2 验证分级）——「系统判不了」本身就是题目质量信号。

---

## 4. 记录契约（judge 独占写入）

`attempts` 行（ADR-007 定为唯一事实源）：

| 字段 | 内容 |
|---|---|
| `ts` | **服务端时间**（不接受客户端时间——防时钟偏差） |
| `qid` / `kid` | 题目与知识点 |
| `verdict` | `server_true` / `server_false` / `undecidable` / `self_reported` |
| `correct` | 1 / 0 / NULL（undecidable 为 NULL） |
| `user_ms` / `device` | 可选 |

**禁止**：客户端提交 `correct` 字段（judge 是唯一的结论生成者）。

---

## 5. 验收测试契约（Day-1 的 TDD 内容）

### 5.1 回归集（外部评审给的 10 例，先红后绿）

| # | 类型 | 用户输入 | 标准答案 | 期望 |
|---|---|---|---|---|
| 1 | 控制 | `1` | `1` | true |
| 2 | 控制 | `3/2` | `1.5` | true |
| 3 | 控制 | `-1/2` | `-0.5` | true |
| 4 | 控制 | `\pi` | `pi` | true |
| 5 | 控制 | `0.5` | `1/2` | true |
| 6 | **攻击** | `1` | `1+sqrt(2)` | **false**（当前基底判 true ← 本契约要修的核心） |
| 7 | **攻击** | `1` | `1+2i` | false |
| 8 | **攻击** | `0` | `0+sqrt(5)` | false |
| 9 | **攻击** | `2` | `2+sqrt(3)` | false |
| 10 | **攻击** | `3` | `3x` | false |

### 5.2 类型边界攻击集（我方补充，MVP 必过）

| # | 场景 | 期望 |
|---|---|---|
| 11 | `matrix` 题，用户填 2×3 而答是 3×3 | `undecidable`（维度不符，**不是 false**） |
| 12 | `vector` 题，用户填 `1 2 abc` | `undecidable`（非数值分量） |
| 13 | `rational` 题，用户填 `1/0` | `undecidable`（分母为零） |
| 14 | `rational` 题，用户填空串 / 纯空格 | `undecidable`（空输入不是错答） |
| 15 | `symbolic` 题，用户填任意内容 | `self_reported` 通道（不判） |
| 16 | 未知 `qid` | 4xx `unknown_qid`（不得静默 false） |

### 5.3 性质测试（property-based，随机 300 例）

- **P1 永不假阳**：对随机 `(u, a)`，若 `verdict == server_true` 则必须能给出「规范化后逐项相等」的证明路径（用两套独立实现交叉验证：字符串精确 vs Fraction 判等）。
- **P2 归一化幂等**：`norm(norm(u)) == norm(u)`（⚠️ v1 原文写作 `judge(judge(u))` 属笔误——判定不是可复合函数）。
- **P3 类型隔离**：任何类型题在错误类型输入下**永不返回 true**。

### 5.4 验收门槛

```
✅ 5.1 全过（10/10）
✅ 5.2 全过（6/6）
✅ 5.3 300 例零违反
✅ grep 证据：判定链路无任何 LLM/网络调用；`parseFloat` 在 core/judge.py 中零出现
```

---

## 6. 与其他契约的接口

| 契约 | 关系 |
|---|---|
| `questions.answer_type` / `questions.answer`（ARCHITECTURE §3.1，表名统一为 `questions`） | judge 的输入侧真值来源 |
| `attempts`（ADR-007） | judge 的输出侧，唯一事实源 |
| DATA_PIPELINE §2 验证分级 | `undecidable` 记录回流为**题库勘误信号**；`auto_verified` 与 judge 用同一套类型判等（一鱼两吃） |
| `modules/practice` | judge 的唯一调用方之一（另一为模块级测试） |
| `contracts/answer_types.py` | 本文 §2 的机器可读化落点（枚举）；**契约改动必须伴随测试变更**（铁律） |

---

## 7. 明确不做（MVP 边界）

- ❌ 不引入 sympy / 任何 CAS（symbolic 走 self_report）
- ❌ 不做「过程判分」（解答题过程永远自评）
- ❌ 不做多答案容忍（一道题多个等价答案暂不支持；如需，由题库侧拆成多题或标 `symbolic`）
- ❌ 不做模糊匹配（拼错=错，不做编辑距离近似——那是假阳性温床）
