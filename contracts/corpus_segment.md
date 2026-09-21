# corpus_segment —— 语料切题**产物契约**（v1 骨架，2026-09-21）

> 定位：数据管线 **② segment（切题）** 段的产物契约 —— **字段清单 + 旁表 DDL 骨架**。
> **为什么先写它、而不是先写完整 ADR**：本 thread 的病因是"**声明没有落点**"（账本立了、schema 没跟）。
> ADR 单独先写，里面的字段就是"想象中 segmenter 能产出什么"，等真跑出来对不上 ⇒ 又是一次同族事故。
> **字段由真跑的第一章产出后冻结**；本文件只是第 1 步的半页契约。
> 关联：`docs/DATA_PIPELINE.md`（§2 验证分级 / §2.A provenance / §5 工具面）。

## 1. 产物：候选 JSON（`data/candidates/<book>.json`）

⚠️ 只在 `data/` 下（`.gitignore` 覆盖）—— **版权红线：语料产物不入仓**。

| 字段 | 类型 | 谁产出 | 说明 |
|---|---|---|---|
| `bank` · `schema_version` · `stage` | str/int | 机械 | 阶段标记（本段恒为 `segment`） |
| `source` · `book_title` · `page_count` | — | 机械 | 出处 |
| `questions[]` | list | — | 逐题 |
| `.qid` · `.number` | str/int | 机械 | 题号 |
| **`.number_source`** | enum | 机械 | **`ocr`** 原位可直接读出 ｜ **`corrupted`** 标记在位但形态/数码讹变 ｜ **`inferred`** 标记真丢、题号由上下文推断 |
| **`.number_evidence`** | obj | 机械 | `raw`（**原始串**，如 `\textbf {[ 5 5 0 ]}`）· `span`（块坐标 `p/idx`）· `neighbors`（N−1 / N+1 的块坐标）· `fixed_from`（修正前的值）。**这是唯一能自证的存证 —— 只存"修正后的值"就永远补不回来了** |
| `.stem` · `.solution` | str | 机械+模型 | 拼接结果 |
| `.provenance` | obj | 机械 | `book` / `page_idx` / `bbox` / `blocks` |
| `.verify` | enum | 机械 | 一律 `unverified`（`DATA_PIPELINE §2`：不进练习池） |
| `.flags[]` | list | 机械 | `digit_split` · `no_solution` · `anchor_mid_block` · `has_image` … |
| **`.boundary_source`** | enum | 机械 | `model` / `mechanical` —— 题干/解答的边界**是谁定的**（审计用） |
| `.confidence` · `.note` | num/str | 模型 | **只作排序，不作 gate**（复核 Q2） |
| **`report`** | obj | 机械 | **`unassigned_blocks`（覆盖对账的未归属块数 + 逐块 `p/idx/type`）** · `no_solution` · **`whitelist_version`** · `flag_counts`。⚠️ 复核点名：**"违规计数"型指标必须配覆盖率读数同报**，否则它跑完只在终端闪一下（与 45/204 同一下场） |

## 2. 旁表 DDL 骨架（**旁表，不加列**）

```sql
-- 为什么旁表而不是给 questions 加列：corrupted 的"位置对账"产物本身是结构化的
-- （夹在 N−1/N+1 之间、形态类型、修正前后值），**一列装不下**（复核给的答案）。
CREATE TABLE IF NOT EXISTS question_provenance (
    qid               TEXT PRIMARY KEY,
    bank              TEXT    NOT NULL,
    book_title        TEXT,
    page_idx          INTEGER,
    bbox              TEXT,             -- JSON 数组（0-1 归一化）
    blocks            TEXT,             -- JSON 数组（参与本题的块序号）
    number_source     TEXT    NOT NULL, -- ocr | corrupted | inferred
    number_evidence   TEXT,             -- JSON：raw / span / neighbors / fixed_from
    verify            TEXT    NOT NULL, -- unverified | ...
    segment_schema    INTEGER NOT NULL, -- 产出它的 segmenter 契约版本
    whitelist_version TEXT,             -- 覆盖对账用的白名单规则版本
    created_at        REAL    NOT NULL
);
```

## 3. ADR 要冻结的四条（先记在这儿；**等第 2 步跑完、与实现同批入库**）

1. **旁表不加列**（理由见 §2 注）。
2. **三值 + 各自的人工义务**：`corrupted` → 位置对账自动修回、仍落 `unverified` 进审校（**不占"回原页"的人工**）；
   `inferred` → **必须回原页核对**。
3. **非题目区只能由机械白名单判定，绝不许模型自报** —— 否则把吞掉的块标成"非题目区"即可自证清白。
4. **"违规计数"型指标必须配覆盖率读数同报**（如未归属块数 + 白名单版本一起进产物）。

## 4. ⚠️ 自动修回的适用范围（施工前必须定死的一条硬约束）

`corrupted` 的自动修回判据是"**夹在 N−1 与 N+1 之间**" —— 这条**只对"全局连号"成立**：

| 书 | 题号体系 | 邻号算术 |
|---|---|---|
| 吉米多维奇 高数 | `【N】` **全书** 1–1341 连号 | ✅ 成立 |
| 吉米多维奇 概率 | `【N.M】` **逐章**重算 | ❌ 不成立 |
| 同济 / 浙大 | `习题 N + (N)`（章内连号 + 子号） | ❌ 不成立 |

⇒ **邻号算术在不同书里不是同一个函数**：**第一版只在吉米多维奇高数开自动修回，其余 7 本一律走人工**，
等形态实测（各书扫描一遍 `corrupted` 形态）之后再放开。
