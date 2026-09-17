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

（待 T3 完成后填写：`python3 -m bridge.api`。）

## 开发：加一个模块

见 `docs/MODULE_TEMPLATE.md`（七步 + 七道质量门）。**不需要改内核。**

## 文档护栏

改完 `docs/` 先跑 `python3 scripts/refcheck.py`（规格见 `docs/ARCHITECTURE.md §14`）。

## 合规

- 上游 MIT 出处与 pin：`ATTRIBUTION`
- 第三方与红线清单：`THIRD_PARTY_NOTICES.md`
- ⛔ 真题/书稿 OCR 内容、任何 API key 永不入仓。
