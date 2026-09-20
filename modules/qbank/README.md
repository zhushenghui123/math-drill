# qbank（题库浏览：栏目 / 题卡 / 详情）

## 一句话

控制台左侧「题库」栏目的数据面：**按学科列出题目卡片**、**进详情看难度与我的复盘**。
只读聚合 `questions` + `attempts` + `agent_notes` + `kp`；不写表、不判定。

> 规格 = **ADR-017**（2026-09-21）。本模块原来是 `enabled=false` 的 P3 预留窗口，
> 该 ADR 把**只读浏览子集**提前到 P1；P3 的其余部分（融合去重、订正链、报错回流）仍未做。

## 对外接口（**走既有模块路由，不是新端点**）

```
GET /m/qbank/list?subject=linear&kid=l1n1&done=false&limit=80   # 栏目页（items 受筛选，subjects 恒为全量）
GET /m/qbank/detail?qid=<qid>                                   # 详情页（题面 + 作答史 + agent 复盘）
```

两条都过 bridge 的**凭据门 + 限速**（`/m/*` 与 `/api/*` 同待遇），且**不加端点** ——
bridge 自有端点集合仍是五个（ARCHITECTURE §11.5 与 refcheck C2b 都不受影响）。
入参 = JSON body ⊕ 查询串（查询串优先，ADR-017 决策 6：原实现只读 body，查询串会被**静默丢弃**）。

## 需求侧对照（决策人 2026-09-17 与 2026-09-21 两次口述）

| 决策人要的 | 现在的落点 | 状态 |
|---|---|---|
| 按学科分栏目 | `list` 的 `subjects[]` + 前端侧栏（学科清单**不写死**，由接口现填） | ✅ |
| 每题一张卡片、可点进去 | `list.items[]` → `#/s/<学科>` 卡片墙 → `#/q/<题号>` | ✅ |
| 难度系数评级 | `questions.difficulty`（1-4）→ 前端显示 ★ + 文字（数值才是真值） | ✅ |
| 没做过 → 只展示题目 | 详情页**只有题面**（服务端不回 answer/analysis，见下） | ✅ |
| 做对 / 做错 → agent 写的复盘 | `agent_notes`（`kind / summary / reason / author / src`） | ✅ 读取；**写入通道未开** |
| 完成度 / 综合评分小组件 | `subjects[].coverage`（做过的题 ÷ 总题数）/ `.score`（做对过的题 ÷ 总题数）/ `.accuracy` | ✅ 定义写死在 `module.py` 顶部 |
| 出自哪本书 / 哪一页 | `questions.source` 单列（如 `ocr:tongji-quanjie-1 p27 习题1-6 1(3)`） | 🟡 单列承载；结构化 provenance 待灌库 ADR |
| "我当时怎么错的"（**作答原文**） | ❌ **没有落点** —— `attempts` 表只有 `verdict/correct/user_ms/device`，**不存输入原文**（本 README 旧版写"输入原文 ✅ 已有"是**错的**，ADR-017 代价 1 已订正） | ❌ 待定 |

## 红线（改本模块前先读）

1. **不回答案**：题目行只从 `Store.list_question_views()` / `get_question_view()` 取 ——
   这两个访问器的**列白名单里没有 answer/analysis**（ADR-017 决策 3）。要"结构上不可能泄露"，
   不要"调用方记得删"。
2. **只读**：不建表（铁律 3）、不写表、不判定（判定一律 `core.judge`）。
3. **时间降粒度到天**：与 `/api/attempts` 同口径（不把"你几点在做题"发出去）。
4. **写权仍关闭**：`Store.record_note()` 目前**没有任何 HTTP 端点调它**（ADR-017 决策 2）。
   将来给 agent 开写权，必须先按 ADR-015 代价 5 重开 ADR-002（blob 双写者）。

## 未做 / 已知限制

- 融合去重（DATA_PIPELINE §3）、订正/重做链、**报错按钮回流**（ADR-014 的第二项最小投资）——都还没做。
- `agent_notes` 的**写入**目前只有离线灌库/演示：插一条
  `Store.record_note(qid=…, kind=…, summary=…, reason=…, src='offline')`。
- 存量库的 `schema_version` 会由 `ensure_schema` 从 1 **前推**到 2（加表幂等）；
  **加列那天必须先补真正的步进迁移**（ADR-017 代价 5）。

## 验收

- `tests/test_qbank_module.py`：只读聚合、列白名单（**结构上无 answer/analysis**）、
  指标定义、日粒度、未知 qid → 404。
- `tests/test_api.py`：`/m/qbank/list` 走凭据门；GET 查询串真的进了 payload。
