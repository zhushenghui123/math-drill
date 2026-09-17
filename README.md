# math-drill

考研数学自适应练题系统（本地优先、服务端判分、手机可用）。

> 本项目 fork 自 `111wukong/kaoyan-math-tutor`（MIT），继承面逐文件裁定见 `docs/BOUNDARY.md`。
> 上游 commit 已钉定，见 `ATTRIBUTION`。

## 现在是什么状态

骨架阶段（T0）。设计文档在 `docs/`，**唯一真值是 `docs/ARCHITECTURE.md §11.9` 的目录树**。

## 目录速览

| 目录 | 作用 |
|---|---|
| `core/` | 命脉：装载器、存储、判定、精确算术（不含 HTTP） |
| `bridge/` | HTTP 唯一持有者 + 进程入口（`python3 -m bridge.api`） |
| `modules/` | 功能块（每块 = manifest + module.py + README + tests） |
| `generators/` | 题源插件（每块同上四件套） |
| `contracts/` | 跨域契约真值（数据叶，五域只读依赖） |
| `web/` | 前端静态根（fork 继承面 + 唯一的同步桥 `web/js/api.js`） |
| `deploy/` | systemd / Caddy 站点块 / 备份 / logrotate |

## 开发：怎么跑

```bash
# ① 服务端（T3 起可用）。注意：绑定与数据目录只读 config/server.toml，
#    没有 env/CLI 覆盖——本地开发就改那一行 data_dir（ARCHITECTURE §13.1）。
MATH_DRILL_TOKEN_FILE=/path/to/token python3 -m bridge.api

# ② 校验（改完 docs/ 先跑第一个；三道全绿再提交）
python3 scripts/refcheck.py                 # 文档自洽护栏（C1 树↔契约 / C2 单源值 / C3 自陈数字）
# Python 套件（本仓用命名空间包，顶层 discover 找不到子目录，故逐目录跑）
set -e; for d in tests generators/*/tests modules/*/tests; do
  [ -n "$(ls "$d"/test_*.py 2>/dev/null)" ] && python3 -m unittest discover -s "$d"
done
node web/tests/run-all.js                   # 前端套件（fork 基线 + 存储桥自测）
```

测试基线（会随新增测试上升，以实际输出为准）：

| 层 | 基线 | 说明 |
|---|---|---|
| 前端（node） | **528 项** | fork 原始 511 + 新增 `test-api-bridge` 17（BOUNDARY §3③） |
| 后端（python3.12 / 3.14） | **59 项** | 判定 13 · 存储 13 · 桥 24 · 依赖纪律 3 · 题源 6（另 `test_exact` 30 断言） |
| 题源 | — | `generators/linalg_det`：48 题 / 8 题族；**同 seed 同字节**（sha256 可核） |

两套都必须双绿；前端 511 是**下限**（只许加不许删）。

## 开发：加一个模块

见 `docs/MODULE_TEMPLATE.md`（七步 + 七道质量门）。**不需要改内核。**

## 文档护栏

改完 `docs/` 先跑 `python3 scripts/refcheck.py`（规格见 `docs/ARCHITECTURE.md §14`）。

## 合规

- 上游 MIT 出处与 pin：`ATTRIBUTION`
- 第三方与红线清单：`THIRD_PARTY_NOTICES.md`
- ⛔ 真题/书稿 OCR 内容、任何 API key 永不入仓。
