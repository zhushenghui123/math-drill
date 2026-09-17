# blob 合并规则（真值）

> 本文件是 blob 合并规则的**唯一真值**（`docs/ARCHITECTURE.md §3.5` 为同内容的人读摘录）。
> 两处不一致时**以本文件为准**。

blob = 服务端持有的**客户端自有状态** JSON（UI 快照视图）。N=1 单用户场景。

| 顶层字段 | 合并规则 |
|---|---|
| ~~`attempts[]`~~ | ⛔ **已退役（ADR-007）**：服务端 `attempts` 表是唯一事实源（judge 独占写入，append-only + 按 id 幂等并入）。blob 里**不再合并 attempts**——照旧规则实现会产生双写路径。 |
| `cards` / `daily` | 按 `updated_at` **newer-wins** |
| `settings` | **服务端是真相源**；客户端改设置 = 显式 PUT 特殊段（避免两设备设置互踩） |
| `checkins` / `game` / `notes` | **newer-wins** |
| `kp_state`（P2a 加入） | 由 `modules/review` 读写；仍是 blob 段，**不是 sqlite 表**（ADR-007） |

## 冲突仲裁

```
服务端 server_version 单调递增；客户端 PUT 必须带 base_version
  base_version == server_version → 接受，server_version += 1
  不匹配                          → 409 + 返回服务端最新 blob（客户端自行重放）
```

## 边界纪律

- 客户端**不得**提交 `attempts` 与任何 `correct` 结论字段（judge 是唯一结论生成者）。
- blob 与 `attempts` 日志分歧时，**以日志为准**。
- 持久层分类：blob（cards / daily / settings / checkins / game / notes / kp_state）
  vs sqlite 四表（`questions` / `kp` / `attempts` / `meta`）。
