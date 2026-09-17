# qbank（题库窗口 —— 预留，未实现）

## 一句话

给"题库数据的整合与提炼"预留的模块位置：查询、按类/难度筛选、做题与勘误的溯源视图。

## 为什么需要它（需求侧，用户 2026-09-17 口述）

> 「不同类型的题目分别存；不同难度的题目标上；哪个题目做了、哪个没做；做了的当时怎么错的、
> 后来怎么修正的 —— 都有溯源。」

## 现状映射（先说哪些**已经**有，别重复造）

| 用户要的 | 现有契约里的落点 | 状态 |
|---|---|---|
| 不同类型分别存 | `questions.answer_type`（rational/vector/matrix/…，JUDGE_CONTRACT §2） | ✅ 已有 |
| 难度标注 | `questions.difficulty`（1-4，ARCHITECTURE §3.1） | ✅ 已有 |
| 哪个做了 / 没做 | `attempts` 表（judge 独占写入，append-only，ADR-007） | ✅ 已有 |
| 当时怎么错的 | `attempts.verdict` + `correct` + 输入原文（JUDGE_CONTRACT §4） | ✅ 已有 |
| 出自哪本书/哪一页 | `provenance`（DATA_PIPELINE §2.A：book/page/ocr/segment） | ✅ 已有（数据侧） |
| 可复现（同参数同题） | `questions.gen_params` + `id = hash(gen_params)` | ✅ 已有 |
| **"后来怎么修正的"** | ⚠️ **暂无**：需要"订正/重做链"（如 `parent_attempt_id` 或 revision 记录） | ❌ 待设计 |
| **跨源融合/去重** | DATA_PIPELINE §3（dup_group / family / 冲突仲裁） | 🟡 设计有、代码无 |

## 对外接口（预留形态，**Phase 3 才定稿**）

只走既有网关，**不开第二个端口**（ARCHITECTURE §11.5：bridge 是唯一 HTTP 面；第二端口会绕过 token 门与限速）：

```
GET /m/qbank/list?type=rational&difficulty=3&done=false   # 筛选
GET /m/qbank/detail?qid=<qid>                             # 单题 + 我的作答史 + 出处
GET /m/qbank/erratum                                      # 我报过的错题/勘误（回流数据管线）
```

客户端侧：`web/js/api.js` 已预留同名的薄封装位。加新 rpc 时，manifest 的 `rpc[]` 与
`contracts/events.py`（如要发事件）同 commit 变更（MODULE_TEMPLATE §8）。

## 数据流（预期）

```
questions（题）+ attempts（事实日志）+ provenance（出处）
        ↓ 只读聚合（不写表、不判定）
   /m/qbank/*  →  web 界面
        ↓ 用户报错
   勘误队列 → DATA_PIPELINE §2 验证分级（unverified 永不进练习池）
```

## 依赖

- `core`：存储受控视图（只读 `questions` / `attempts`）
- `contracts`：`answer_types.py`（类型枚举）
- 不引入任何第三方依赖（H1）

## 未做 / 已知限制

- 现在 **`rpc` 为空、`enabled=false`**：本模块只是窗口，不代表任何承诺。
- "订正链"的数据形态未设计——**动它之前先写 ADR**（涉及 attempts 的事实源语义，ADR-007）。
- 不做判定：任何答案比对一律调 `core.judge`（铁律 3）。

## 验收方式（Phase 3 落地时补）

（待定：至少覆盖"按类/难度筛选"与"溯源链可回溯到 provenance"两类用例。）
