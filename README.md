# 📐 研数 · 考研数学自适应练题系统

> 不是又一个题库，是一台**记得住你错在哪**的练题机——服务端确定性判分、按天选题、agent 在旁边陪你复盘。
>
> *adaptive math drill · server-side grading (no LLM in the judge) · local-first · agent-ready*

<p align="center">
  <a href="#"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT License"/></a>
  <a href="#"><img src="https://img.shields.io/badge/python-3.12-blue.svg" alt="Python 3.12"/></a>
  <a href="#"><img src="https://img.shields.io/badge/backend-stdlib--only-lightgrey.svg" alt="stdlib only"/></a>
  <a href="README_EN.md"><img src="https://img.shields.io/badge/English-README-blue.svg" alt="English"/></a>
</p>

研数把「做题」这件事拆成四件可验证的事：**题目从哪来**（题源生成器 + 自建语料）、
**怎么判**（服务端确定性判定，判定链路里没有 LLM）、**今天练什么**（按天确定的选题器）、
**错在哪**（题卡、考点、agent 复盘）。手机浏览器可用，服务端零第三方依赖。

## 目录

- [✨ 特性](#-特性)
- [🖼️ 形态展示](#️-形态展示)
- [🚀 快速开始](#-快速开始)
- [🧠 判分与选题](#-判分与选题)
- [🤖 接一个 agent](#-接一个-agent)
- [🏗️ 架构](#️-架构)
- [🧩 开发：加一个模块](#-开发加一个模块)
- [🔒 安全与数据设计](#-安全与数据设计)
- [❓ FAQ](#-faq)
- [🗺️ 路线图](#️-路线图)
- [📜 致谢与许可](#-致谢与许可)

## ✨ 特性

**题库与练题**
- 自建语料：教材/习题集/真题经 OCR → 切题 → 知识点映射 → 入库（**语料本身不入仓**，入仓的是生成器与格式契约）
- 练习池 2700+ 题，6000+ 题带难度；难度分 1（入门）/ 2（基础）/ 3（进阶）/ 4（挑战）
- 题库页三维筛选：**章 / 状态 / 按考点**；每题一张卡，点进详情看难度系数与复盘
- 没做过只给题面；做过的题给「agent 评」——判分依据（题面/答案/题库难度）一个字都不动

**判分与选题**
- **判定链路无 LLM**：对错由服务端确定性判定，答案只下发给浏览器会话（agent 永远拿不到答案）
- 按天确定的选题器：跨章铺开 + 先新后旧 + **错题回炉 25%**（同一天同一份题单，谁打开都一样）
- 每道题可点「报错」，进反馈队列（人工/agent 都看得到）

**多用户与 agent**
- 邀请制开户 + 边缘鉴权（Authelia）；**每人一套**作答、笔记、题库标记，互不可见
- 每人一把 **agent 凭据**：agent 用自己的身份读写，不与别人混淆
- DSH（DeepSeek Harness）插件**只做数据面**：3 个只读工具 + 2 个白名单写工具 + `/math` 命令
- **难度以 agent 的判断为准**：agent 讨论过这道题后写回难度，题库原生值保留留痕（append-only）

**工程**
- 服务端**零第三方依赖**（纯 stdlib `http.server`），前端零构建
- 三道护栏：文档自洽 `refcheck.py`（树↔契约 / 单源值 / 自陈数字 / 部署件入树）+ Python 套件 + 前端套件
- 一切皆模块：**加功能 = 加一个目录**（`manifest` + `module.py` + `README` + `tests`），内核不动

## 🖼️ 形态展示

![题库页](docs/screenshots/console-questions.png)
![题目详情：难度系数与 agent 复盘](docs/screenshots/console-question-detail.png)
![今日题单](docs/screenshots/console-daily.png)

## 🚀 快速开始

只依赖 **Python 3.12+**（服务端）与 **Node 22+**（前端测试/插件）。

```bash
# 1) 起服务（绑定与数据目录只读 config/server.toml，没有 env/CLI 覆盖）
cp config/server.example.toml config/server.toml   # 改 data_dir / 端口
MATH_DRILL_TOKEN_FILE=/path/to/token python3 -m bridge.api

# 2) 建库（本地开发：--repo 必须指向本仓，否则会写生产路径）
python3 scripts/db_init.py --repo "$PWD" --data-dir "$PWD/data" --load-kp-js web/js/data-knowledge.js
python3 scripts/gen_bundles.py --repo "$PWD" --out "$PWD/data/bundle-v1.json"
python3 scripts/db_init.py --repo "$PWD" --data-dir "$PWD/data" --load-bundle "$PWD/data/bundle-v1.json"

# 3) 打开 http://127.0.0.1:8081/ （手机浏览器同网段也能用）
```

改完代码**先跑三道护栏**（全绿再提交）：

```bash
python3 scripts/refcheck.py                      # 文档自洽（C1–C4）
python3 -m unittest discover -s tests            # 后端 155 项
node web/tests/run-all.js                        # 前端 578 项
cd dsh/math-drill-plugin && node --test tests/*.test.mjs   # 插件 23 项
```

## 🧠 判分与选题

**判分**：答案是纯数据（精确算术 + 题型判定器），不调用任何模型；`answer/analysis`
只在**浏览器会话**下发——服务端按身份分流（`with_answer = (identity == "browser")`），
**不留查询参数入口**，所以 agent 侧永远看不到答案（它在讲解侧，不在答案侧）。

**选题**：`core/picker.py` 按「日期 + 目标」确定性地生成今天的题单：跨章铺开、先新后旧、
错题按比例回炉。同一天重复打开是同一份，便于复盘与打卡。

## 🤖 接一个 agent

`dsh/math-drill-plugin/` 是给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的桥接插件，
**只做数据面**（展示一律在控制台里）：

| 工具 | 作用 |
|---|---|
| `math_drill_progress` | 进度、目标考试与剩余天数、今日完成度、打卡 |
| `math_drill_today` | 今天该练什么（题数/考点分布/难度分布/题型/题号，**不回题面**） |
| `math_drill_review` | 最近对错与正确率、最该复习的考点（kid→人话）、最近错题 |
| `math_drill_set_difficulty` | 把 agent 判定的难度写回题库（`reason` 会显示在题目详情） |
| `math_drill_write_review` | 把 agent 的评语写回控制台（`kind=grade|review`） |

两条红线写在代码里：**答案不进上下文**（进模型前剥掉 `answer/analysis`）、
**写面白名单**（`WRITE_METHOD_NAMES` 由测试盯着，不许长大）。

## 🏗️ 架构

```text
core/           命脉：装载器 · 存储 · 判定 · 精确算术（不含 HTTP）
bridge/         HTTP 唯一持有者 + 进程入口（python3 -m bridge.api）
modules/        功能块（每块 = manifest + module.py + README + tests）
generators/     题源插件（同上四件套：生成题 → bundle → 入库）
contracts/      跨域契约真值（数据叶，各域只读依赖）
web/            前端静态根（零构建；唯一的同步桥是 web/js/api.js）
dsh/            DSH 插件（只做数据面）+ 部署件
deploy/         systemd / Caddy 站点块 / 备份 / logrotate
docs/           设计文档（ARCHITECTURE=唯一真值 · DECISIONS=ADR · 其余按主题）
scripts/        建库 / 切题 / 跑批 / 护栏
```

设计哲学：**服务端判分 + 一切皆模块**。题目、判定、选题、反馈各是一块；
新能力落在一个目录里，内核（`core/`）不改。

## 🧩 开发：加一个模块

加功能不需要懂内核——新建一个目录，补齐四件套即可：

```text
modules/<name>/
├── manifest.json     # 声明 id/版本/依赖的契约
├── module.py         # 实现（只依赖 contracts/ 与 core/ 的公开面）
├── README.md         # 这块是什么、边界在哪
└── tests/            # 必须自带测试
```

七步流程与七道质量门见 [`docs/MODULE_TEMPLATE.md`](docs/MODULE_TEMPLATE.md)；
加一个**题源**则是 `generators/<name>/` 同构四件套（生成 → bundle → 入库，可 sha256 复现）。

加一个**只读端点**是架构级改动：`bridge/api.py` 的 docstring 写着"自有端点恰好 N 个"，
必须同批改四处（主句 / 同段回指 / 路由表 / docstring），`refcheck.py` 的集合检查会当场报红。

## 🔒 安全与数据设计

- **判定无 LLM**：分数不来自模型；agent 的评语在控制台显示为「agent 评」，不是官方判分
- **答案不出浏览器**：`/api/daily` 只对浏览器会话下发答案，agent 侧永远拿不到
- **凭据不入仓**：API key / 服务 token / agent 凭据只落 `600` 文件，部署件里只写**路径**不写值；
  仓库历史经过全量扫描（无任何真凭据），见 [`docs/OPEN_SOURCE.md`](docs/OPEN_SOURCE.md)
- **语料不入仓**：教材/真题 OCR 产物与数据库一律 gitignore，对外只放**生成器**与**格式契约**
- **多用户隔离**：每人一套作答/笔记/标记 + 每人一把 agent 凭据；身份来自边缘鉴权注入的请求头
- **写面白名单**：agent 只有两个写工具，且都由测试盯着不许扩张

## ❓ FAQ

**要 GPU 吗？**
不需要。服务端是纯 stdlib，跑在 2C/4G 的小机器上；OCR 语料是离线一次性工作，不参与运行时。

**题目从哪来？会带着教材内容一起开源吗？**
题目来自自建题源生成器 + 自建语料（自己扫描/OCR 的教材与真题）。**语料与题库数据不入仓**——
开源的是**怎么生产、怎么判定、怎么选题**这套东西，不是受版权保护的题目本身。

**为什么判分不用 LLM？**
因为分数要可复现、可追责、可回归测试。模型放在**讲解侧**（agent 陪复盘、定难度、写评语），
而不是判定侧；这也是它能长时间稳定跑的原因。

**手机能用吗？**
能，前端是响应式的（题库/题卡/详情/打卡都按手机视口设计过）。

**能不用 DSH 吗？**
能。DSH 插件只是**一个客户端**；控制台本身自带 HTTP API（Bearer 鉴权），谁都能接。

## 🗺️ 路线图

- [x] 服务端判分 + 题库 + 今日题单 + 打卡
- [x] 题库三维筛选 / 题卡 / 详情（难度系数 + agent 复盘）
- [x] 多用户 + 边缘鉴权 + 每人一把 agent 凭据
- [x] DSH 插件（只做数据面）+ 难度/复盘写回白名单
- [x] 护栏：文档自洽 `refcheck` + 三套测试
- [ ] 间隔重复（SM-2/FSRS）——等作答历史攒够
- [ ] 报错队列的管理界面
- [ ] 学习报表（周报/月报）

## 📜 致谢与许可

- 本项目 fork 自 [111wukong/kaoyan-math-tutor](https://github.com/111wukong/kaoyan-math-tutor)（MIT），
  上游 commit 已钉定，继承面逐文件裁定见 [`docs/BOUNDARY.md`](docs/BOUNDARY.md) 与 [`ATTRIBUTION`](ATTRIBUTION)
- 第三方与红线清单：[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)
- 本项目代码：**MIT**（见 [`LICENSE`](LICENSE)）

---

[English README](README_EN.md) · 欢迎 Star / Issue / PR —— 把它改成你自己的练题机 📐
