# 架构决策记录（ADR）· math-drill

> 格式：背景 / 决策 / 代价（诚实版）。每条决策被推翻时**不删除**，追加状态 `已取代` + 新编号。
> 这是工程正规军习惯，也正好是你学 agent 工程时最该掌握的一页纸纪律。

---

## ADR-001 · 基底选择：fork kaoyan-math-tutor（MIT）

- **背景**：四路生态调研（2026-09-14~18）证明「知识点级自适应 + 精确判定 + 服务端持久化 + 手机可用 + 题库导入」无项目集齐。候选第一梯队：该基底 / gre2tor（GPL，规则逐字对但 Leitner 封顶 7 天）/ OATutor（BKT 真，永久跳过）/ OpenTutor（学习科学最扎实但移动端未完 + LLM 生题）
- **决策**：fork 基底，迁移存储层 —— 它是唯一同时锁住「考研内容 + 选择器真实现 + SM-2 校验正确 + @media + 测试」的
- **代价（承认）**：★0 单作者风险；继承面 2,606 行（classroom 851 / cards 541 / game 497 / llm 385 / agent 332）含我们不需要的多智能体课堂；511 测试对我们最要改的「状态+选题层」零覆盖（4 处 nodeStatus 全桩、pickDailyQuiz 零命中）——所以骨架规定「动刀前先补测试」
- 裁判：外部评审 GO（Q2 同意我方反证：★0 不是否决项）

## ADR-002 · 存储同步 = blob 同步（方案 A）

- **背景**：基底 state 是单体 blob（save() 序列化整体）；评审指出「blob」与我草案「原子端点」设计**互不相容**，必须先选边
- **决策**：**方案 A** —— 客户端保持单体，整块去抖 PUT（带 `base_version`），服务端只剩 4 个端点；合并规则按 §3.5（attempts append-only / 其余 newer-wins / settings 服务端为真相源）
- **代价**：放弃细粒度仲裁（并发写冲突靠低概率赌）；升级条件写死（真实冲突 >0 次/月 再上 oplog）；单用户架构自证
- 裁判：评审 Q3 定案

## ADR-003 · 判定 = 类型驱动契约 + fail-closed；LLM 永不进判定链路

- **背景**：评审实测基底 `Judge.checkBlank` **fail-open**（parseFloat 前缀截断 → 答题"1"对"1+sqrt(2)"判 true），独立复跑确认假阳性 5/10
- **决策**：`questions.answer_type ∈ {rational, vector, matrix, interval, set, symbolic, self_report}`；判定三分支 = 类型内精确比对 / 解析失败或过界 → `undecidable → self_report`（**绝不猜**）/ 自评类型为一等公民（Q7 裁决）；`norm()` 保留、`parseFloat` 回退删除；**MVP 不引 sympy**（P4 才评估）
- **代价**：symbolic 类答案 MVP 全部自评（自评率上升）；换来判定链路从「名义红线」变「结构保证」
- 裁判：评审根因 2，学生半强制接受

## ADR-004 · 调度：SM-2 迁移起步；FSRS 留 P4；粒度先行

- **背景**：基底混用 `state.cards` 键（KP 按 kid / 错题按 card.id，app.js:449 vs 454）；且权重含**无时间衰减的历史累计**——评审根因 1：这是「自适应」名义与结构的空隙，也是 511 测试零覆盖区
- **决策**：① 一阶决策 = **粒度定死 KP 级**（kp_state 主键 user×kid，先处理混合键迁移）② SM-2 起步（fsrs optimizer 需大量 review log；数据量不足）③ 选题器重写（Phase 2b）**先写单测再实现**，权重输入必须「当前时刻可计算」+ 历史累计全部经 `exp(-Δdays/τ)` 衰减（τ 默认 10 天，config 可调）④ FSRS 的 stability/difficulty 字段在 schema 中**预留不填**，P4 实测数据量之后再议
- **代价**：若 P4 真上 FSRS，kp_state 字段需补 FSRS-6 的 21 参数载体；P2a 的迁移功要写得兼容 blob 与表两态
- 裁判：评审 Q5（结论一致，理由升级为「二阶决策论」）

## ADR-005 · 服务端零第三方依赖（纯 Python stdlib）

- **背景**：腾讯云轻量 2C2G / Python 3.12.3（已实测）；学生单独维护，2~3 年生命周期
- **决策**：`http.server + sqlite3(WAL) + json + fractions`；测试用 `unittest`（弃 pytest），数学内核已是 stdlib（exact.py 454 行 / 30 断言，含双算法互证与恒等式族）
- **代价**：失去生态轮子 aesthetic（如 FastAPI/pydantic 的 schema 校验）；换取的是 **2 年不腐烂**（不会因依赖升级突然失效）与 **~零部署摩擦**（clone + python3 app.py）
- 裁判：学生偏好（零依赖哲学），评审未反对

---

## ADR-006 · 骨架组织 = 「一切皆模块」（吸收决策人 whale-moe 实践章法）

- **背景**：决策人指定参考其个人项目 whale-moe（31MB / 207 文件 / 2026-08-31 活跃；结构实证：`console/modules/<一块=module.py+page.html>` 自包含；`agent/widgets/base.py + registry` 的「加文件即加功能，骨架零改动」；`bridge/control_api.py` 唯一跨界通道 + mutating 变更入队；`shell/`、`agent/`、`console/` 壳与内容分离；README 把「🧩 开发：加一个小组件」写成一等章节——新文件自动获得语音工具 + Web 卡片 + 桌宠联动三重接线）+ DSH「一切皆插件」模式。决策人立场：**低耦合、块状叠加、强可扩展**。
- **决策**：骨架 v2.1，三条铁律——① **单向依赖**：`module → core` 允许，`core → module` 禁止；core 只认 MANIFEST 不认模块名，装载由 registry 完成；纪律由 `tests/test_dep_rules.py` 机械化执行 ② **块内自治**：每模块自含逻辑 + UI（如有）+ MANIFEST + 自述 + 自测；跨模块通信只走 core 契约与 registry 事件表 ③ **命脉不插件化**：HTTP 服务、blob 持久化、判定契约仲裁永远在 core（N3 属于内核，不是可替换件）。仓库树相应拆分：`core/ + modules/ + generators/ + bridge/ + contracts/`；§5 选题器迁入 `modules/picker/`；fork 上游补丁进 `patches/`；合规单升格为 `THIRD_PARTY_NOTICES.md`
- **代价（承认）**：① stdlib 没有 cordis 类现成注册总线，registry 装载器自写（仅为扫描+校验，非容器框架，体量小）② 模块四件套（目录+清单+自述+测试）有前期文书税——换取 2-3 年里「加功能不起手术」③ `contracts/` 目录有退化成二手真值的风险——规则：契约改动必须伴随对应测试变更
- **收益**：与决策人「每块独立叠加」的直觉完全对级；与 DSH profile/bundles 的心智模型同构（两套系统互迁零摩擦）；classroom「隐藏不开」从 TODO 变为启停表一行
- 裁判：决策人主动指定（whale-moe 为其个人实践项目，章法自证）


### ADR-006 · v2.2 追记（质检官地基石复核闭环，2026-09-17）

质检官冷启动复核证实八条章法全部为真、本轮零代码属真，但提出三条改变目录形状的地基石（P1/P2/P3）。链式裁决已按 `docs/ARCHITECTURE-v2.md §11` 定案：

- **P1 → `core/exact/`**：铁律 3 的判据（「判定正确性属于内核」）自证 exact 是命脉，core 清单由 4 项升为 **5 项**。由此 **`generators → core` 成为合法依赖边**，并把「generators ↔ modules 横向边」显式焊死为 ✗（允许矩阵 §11.4）
- **P2 配置 stdlib 化**：MANIFEST=JSON、启停表=TOML（tomllib）；**全仓无 yaml**。质检官「部署必炸」按它环境推演——我方服务器实测：tomllib ✓、yaml 意外**存在**（系统装），「当场炸」不成立；但「依赖环境随机产物」的原判断不变，纪律照执行。**证据链闭环了它「无法登机」的缺口**（服务器三连：3.12.3 / tomllib / yaml）
- **P3 单源边界**：kp_state 定为 **blob 段**（非 sqlite 表），MANIFEST 的 `tables[]` 改 `blob_fields[]`；ADR-002 无需重开。连带真修正：**attempts 从 blob 合并规则退役**——blob 是客户端视图，服务端 `attempts` 表为唯一事实源（judge 独占写入）——详见 ADR-007
- 另收：S1 六域依赖矩阵、S2 路由权威（bridge 单门挂 `/m/*`）、S3 文档卫生（§2 SUPERSEDED 横幅 / 自测位置定案 / events.py 枚举）、日期纠偏、解释器矩阵（目标 3.12.3 / 开发 3.12.13+3.14.7 双绿）

**最终树形由 ARCHITECTURE v2.2 §11 为准（v2.1 §10.B 树含五处修正引至 §11）。**

---

## ADR-007 · 单一真相源的机械边界（v2.2，P3 定案）

- **背景**：v2.1 里「blob 持久化在 core」与「MANIFEST tables[] 声明模块表」并存——质检官指出这是把单源语义**声明式绕过**（同 ADR-002 原文「废弃原子端点」互斥）；且 §3.5 的 attempts 合并行与「judge 独占写入」冲突
- **决策**：
  1. **持久层分类**——blob（服务端持有的客户端状态 JSON）：cards / daily / settings / checkins / game / notes / kp_state（Phase 2a 加入），全是「客户端自有、可视图快照」；sqlite 持久层只保四件：`questions` / `kp` / `attempts`（append-only 事实日志，judge 独占写入）/ `meta`
  2. `attempts` 从 blob 合并规则**退役**：分歧以服务端日志为准（append-only + 幂等并入）
  3. 模块以 `blob_fields[]` 声明自己读写的段名（可审计），不再声明表
  4. P2a 迁移形状 = blob 内纯函数键迁移（可回滚）
- **代价**：blob 与 attempts 日志在 P1 过渡期双拷（客户端视图为快照、以日志为准）——N=1 下无害；P2a 起客户端 attempts 直接读服务端视图，双拷退役
- 裁判：质检官 P3（我方按「段」落款 + 采纳它揪出的 attempts 真矛盾）


---

## 裁决引用

- 评审原文位置：`adaptive-practice-survey/技术评审请求-致Claude.md`（请求）→ 学生会话中的 Claude 裁决全文
- 我方回执与执行清单：`adaptive-practice-survey/评审对齐-执行清单v2.md`（含独立复验记录表 10/10）
- 章法源：决策人项目 `math-practice-survey/clones/whale-moe/`（README 🧩 节 + bridge/control_api.py 头注 + console/modules 排版）

---

## ADR-008 · 数据资产定位：OCR 题库是平行的长线工程，通过 contracts 共享不耦合（v2.2 后新增）

- **背景**：决策人提出数据为中心的长期策略——名师书/权威书/竞赛书经 OCR 提取后**多源融合**成不断迭代的题库；判断「提取机械、融合才是技术」；不信任公开免费数据集的质量。教学侧校准三点：数学公式 OCR 非纯机械（需置信分级复核回路，其《大话计算机》管道是纯文字流先例）；融合的核心=答案规范化/受控词表打标/验证分级；公开题库（如墨题库）可作**交叉校验参考**而非直接入池
- **决策**：数据管线**独立成平行工程**——`docs/DATA_PIPELINE.md`（六段流水线 ingest/segment/formula/annotate/verify/fuse）；与练题系统**只共享 contracts/**（qa schema + 68 考点树 + answer_type），不进 server 运行时；「验证分级门」四档（auto_verified / cross_checked / human_confirmed / unverified），**unverified 永不进练习池**——这是 N3 在数据侧的镜像（LLM 只参与⓪标注提议，判定链路永无 LLM）；provenance 挂在每题（book/page/ocr 引擎与置信度/segment 锚点/relations）；OCR 类资产**永不进开源仓库**（以 practice_pool 永远只是 provenance 库的视图这一约束保证）
- **代价（承认）**：①第一本书端到端约 1~2 周（含管线调试），是的——决策人「最长时间在数据」的判断成立且被接受 ②ⓛ LLM 标注引入标注质量风险——缓解：受控词表 + 置信门 + 人工确认才算落库 ③验证分级初期 auto_verified 占比可能很低（解答题多走 human_confirmed），练习池早期以生成器产物为主——这正是 Phase 1~2 只用生成器起步的理由
- **收益**：决策人指出的核心长期资产有了纪律骨架；生成器（技术快线）与 OCR 题库（长线资产）双轨并行不互相阻塞；练题的练习用例反哺审校队列（用户做题发现错题=报错=数据迭代），形成本项目独有的数据飞轮
- 裁判：决策人主动提出（本设计将其直觉转译为验收可测的纪律），导师补 OCR 非纯机械、验证分级、合规分层三处约束

---

## ADR-009 · OCR 引擎选型修订：MinerU 4.0 首选，20 页对拍定门槛（v1.0，2026-09-17）

- **背景**：决策人 2026-06 以 Marker 完成《吉米多维奇》全本提取（五轮迭代战胜 MinerU1.x 环境地狱/Pix2Text 公式误判）；2026-09 复核发现格局巨变：Marker 2.0 重写（本地推理服务器形态，PyPI 依赖含 anthropic，`SURYA_DEVICE=cpu` 一键直调消失）+ OmniDocBench v1.7 全榜 35 位中 78.44 垫倒数第二（公式 CDM 85.24 vs 公式榜首 97.53/榜二 97.49）——本研究由双路子代理 + 主会话独立解析全表 35 行三链交汇
- **决策**：首选 **MinerU 4.0 standard 档**（uv 一键 + ONNX CPU + llama.cpp Vulkan，不踩 torch/paddle——正面修复老五坑；MinerU2.5-Pro 权重 Overall 95.75 / 公式 97.45；管线工装最厚对接 ingest/segment 段）；**A/B = Chandra 2**（同母公司后继，中文扫描数学书窄题口碑 + 决策人迁移摩擦最小）；**现有 Marker 输出保留为对照组**；**PaddleOCR-VL-1.6-GGUF**（公式 CDM 榜首 97.53、官方 GGUF 可 llama.cpp）列为公式质量不及格时的升级项
- **代价（承认）**：①TeleOCR 2026-09-11 刚进榜首，社区验证不足（未列为首选的理由）②MinerU 4.0 发布仅一天，公式 bug 仍在连续提交中（两路口碑同证）——因此**强绑 20 页 A/B 对拍作验收**，不以榜单数据替代实拍 ③OmniDocBench 为 MinerU 母团队出品，公允性靠「榜首非 MinerU + 公式维度非 MinerU」两点自证，仍保留「以多基准交叉（olmocr-bench Marker 76.0）确认 rank 落后于同期专用 VLM」的边界 ④DeepSeek-OCR 排除是 Blackwell sm_120 教训的重演——决策人 RTX 5060 即 Blackwell
- **纪律**：本节证据日期 2026-09-17；**91 天保鲜期**——>90 天启动管线须重刷榜单（OmniDocBench 1-2 月一更）
- 裁判：决策人提交旧笔记主动求证（「工具迭代非常快 查一下是否过时」）

### ADR-009 · 修订（2026-09-17 晚，B 路完整报告到达后）

原文「首选 MinerU 4.0 / A/B = Chandra 2」的二分表述被**三轨定案**取代（见 DATA_PIPELINE §8.3），变更原因：

1. **两路子代理分歧的裁定**：A 路（工具核验）重安装与管线工装 → 判 MinerU 首选；B 路（社区口碑）重公式精度，挖到 MinerU **2026-07~09 公式 bug 连续流**（#5479 行内公式重复符号 / #5383 表格公式漏识 / #5289 公式编号多括号 / #5275 表格公式导出裸 LaTeX）→ 判 Chandra 2 首选。两者证据均成立，**根源是评估轴不同，故不选边**：改为「骨干(MinerU 4.0) + 公式专轨(PaddleOCR-VL-1.6-GGUF) + 精度参照(Chandra 2)」三轨并行，用 20 页样书实验做裁决。
2. **Chandra 2 的硬件事实补齐（主会话核验）**：`chandra-ocr` 0.2.0（2026-03-18）；官方基准跑在**单张 H100 80GB**、推荐 vLLM；本地 HF 模式需 torch≥2.8+transformers≥5.2 → **8GB 显存可行性未验**，故不能作骨干，降为参照轨 + 显存闸门。
3. **Chandra 2 许可证事实补齐**：代码 Apache-2.0，**权重 modified OpenRAIL-M**（个人/研究免费、商业自托管需授权、不得与官方 API 竞争）——与决策人开源意图存在边界，需留在案。
4. MinerU 的四条已知公式 bug 升为**骨干轨的前置回归测试**（不是放弃理由，是可验收条件）。

结论不变：**决策人 2026-06 的 Marker 选型需要更换**（形态与位次双双落伍）；变的是新方案的结构从"单选"改为"三轨 + 实验裁决"。

### ADR-009 · 二次修订（2026-09-17 深夜，A 路完整报告到达后）

Chandra 2 的「硬件闸门未验」升级为**已判定不适配**：实测为 **5.3B 参数，BF16 约 11GB 显存**，超出决策人 RTX 5060 的 8GB —— 故从三轨定案中**出局为观察级**（仅可在官方 playground 免费额度上做困难页人工比对，或等将来换卡）。

同时采纳 A 路的 8GB 可行性清单（实测判）：**可行 = MinerU 4.0（llama.cpp Vulkan）/ PaddleOCR-VL-1.6（0.9B，官方 GGUF 走 llama.cpp）/ GLM-OCR（1.3B，MIT）**；**不适配 = Chandra 2（5.3B/11GB）**。故三轨定案的第三轨改为「观察候选：GLM-OCR / TeleOCR」，且后者的成熟度待验（2026-09-17 刚上架）。

补入的运行时事实（Marker 2.0）：GPU 平衡模式需 vLLM+Docker+NVIDIA Container Toolkit；CPU 模式改走 llama-server；surya 换 650M OCR-VLM。另确认 `magic-pdf` 包名停于 1.3.12（2025-05），继任者即 `mineru`。

**本次修订的方法论含义**：这是本轮第二次「自己刚给的结论被下一批证据修正」（第一次是 wmathor 误判仓库已死）。已固化为纪律——**结论必须带证据日期与保鲜期，且子代理报告要等全部到齐后才落终稿**。

---

## ADR-010 · 进程入口与装载豁免（v2.5，回应独立复核 B4/B5/B3）

- **背景**：v2.2 同时写了「`core/server.py` 是进程入口」与「HTTP 面唯一持有者 = `bridge/api.py`」——
  二者并存会强制出现 `core → bridge` 依赖边，与六域矩阵（core 行全 ✗）冲突；且 `core/registry.py` 必须装载模块，
  与「core 不得 import 模块」的纪律天然打架，导致 `test_dep_rules.py` **无法写出**（复核 B4/B5）。
  另：矩阵 core 行的 `contracts` 格标 ✗，而 T1 要求 `core/judge.py` import `contracts/answer_types.py`（复核 B3）。
- **决策**：
  1. **进程入口 = `python3 -m bridge.api`**；**删除 `core/server.py`**。bridge 同时是「HTTP 唯一持有者 + 进程」
     （完全对齐决策人 whale-moe 的 `bridge/control_api.py` 形态：一台轻服务器兼静态服务与 JSON API）。
  2. **装载豁免**（写入 ARCHITECTURE §11.4.1）：core **静态** import 模块/bridge 一律禁止；
     **唯一豁免** = `core/registry.py` 的动态装载，且必须是全仓单点（`importlib` 只允许出现在该文件），
     载入路径必须逐个出自 `manifest.json`。`test_dep_rules.py` 用「AST 扫描 + 单点检查 + 清单对齐」三项执行。
  3. **矩阵 core 行 `contracts` 格改 ✓**（contracts 是被五域只读依赖的数据叶）。
- **代价（承认）**：① 入口在 bridge 意味着「命脉 core 不能独立起进程」——调试时须经 bridge（可接受：本就无独立用途）
  ② 动态装载的存在使「纯静态依赖图」不再成立，故纪律必须靠机械测试守住，人工审查会漏 ③ 删除 `core/server.py`
  使 v2.2 §10.B 树又多一处偏差（已由 §11.9 真值树收敛）。
- **顺手记录**（同批消歧，非架构级）：表名统一 `questions`（原 `qa` vs `questions` 二义）；`config/modules.yaml`→`.toml`；
  `§3.5` 的 attempts 合并行标废弃；`/api/questions` 明确为非运行时端点；Phase 1 题源统一为**线代 Ch1 ≥40 题**（Ch2 移出）；
  新增开放决策 **D6**（node 测试落点 `web/tests/`）。
- 裁判：独立复核（读文档 + 实跑 6 处悬空全部命中），规划方裁定

---

## ADR-011 · 凭据落点与静态根（v2.6，回应复核第二轮两条新缺口）

- **背景**：v2.5 删掉 `core/server.py` 与旧树后，**运行时常量与 token 的落点一同消失**——`§5` 仍写「τ 默认 10 天(config)」
  而那个 config 已不存在；token 的签发/存放**全仓无定义**，但 H7 禁它入仓、T3 与 §12.4② 又要求 token 门生效，
  执行方到 T3 只能自行发明（属设计层决定）。另一缺口：§11.9 只写了 `web/pages`（js）与 `web/assets`，
  **静态根与 `index.html` 落点未定**，而 T4 明确要改 `index.html`。
- **决策**：
  1. **常量与凭据分家**：运行时常量（绑定/端口/cookie TTL/限速/数据目录/τ）落 **`config/server.toml`（随仓库提交，非机密）**；
     **token 落 `/etc/math-drill/token`（chmod 600，属主 math-drill），路径经 systemd `Environment=MATH_DRILL_TOKEN_FILE` 注入，
     缺失或为空则拒绝启动（不设默认 token）**。
  2. **下发走一次性入口**：`/setup?t=<token>` 常数时间比对 → 成功下发 `HttpOnly; Secure; SameSite=Strict`（365 天）cookie → 302 回 `/`；
     失败仅 401 且不回显；该端点独立限速（默认 3/小时）；轮换 = 重新生成 + 各设备重走 setup。
  3. **静态根 = `web/`**，入口 `web/index.html`；`web/tests/**` 与任何 dotfile **一律 403**；取消含糊的 `web/pages/`。
- **代价（承认）**：① 多了一个部署前置步骤（生成 token 文件），T7 失败面 +1 —— 用「缺失拒启」把失败暴露在最前面而非运行期
  ② `/setup?t=` 会让 token 短暂出现在浏览器地址栏与历史里（缓解：一次性、限速、日志不记值、可随时轮换）
  ③ 若以后要多设备免 setup，需引入设备注册（当前 N=1 不做）。
- **与既有约束的一致性**：H7（凭据零入仓）从「禁令」升级为「可执行的存放路径 + 注入方式」；
  三处 fail-closed 一致（token 缺失拒启、setup 失败不回显、目录越权 403）。
- 裁判：独立复核第二轮（两条缺口由它提出，规划方定案）

---

## ADR-012 · v2.7 定点修正批（树↔契约对撞、部署单元、会话派生、限速语义）

- **背景**：第三轮独立复核（质检官定点 + 复核者逐条复跑取证）在 v2.6 上又抓到 4 条阻塞级与 3 条清单级。
  其中**两条是 v2.6 补丁自身引入的**——「补丁自身引入回归」在本项目第二次实证：§11.9 树未随 §13 同步新增 `config/server.toml`（B1，导致 T0 被自己的验收判为不一致），以及 §11.5「bridge 自有端点恰好三个」与 §13.2 `/setup` 行的歧义（B2）。
  另两条：systemd 单元缺 `MATH_DRILL_TOKEN_FILE`（照 §12.1 原文部署**必然拒绝启动**，B3a）；会话 cookie 写「随机会话值」但全仓无处存放会话、且「轮换 token ⇒ 旧 cookie 失效」这条安全性质**根本不成立**（B4）。
- **决策**：
  1. **B1 树补全**：§11.9 的 `config/` 增 `server.toml`（§13.1 的运行时常量真值）+ `server.example.toml`（对照样例，不含凭据）。
  2. **B2 端点语义**：`/setup` 明确为**唯一不过 token 门的引导端点**——它本就是换取凭证的入口，过门即死锁；只受 §13.3 独立限速。「恰好三个」限定为 `/api/*` 自有端点。
  3. **B3 部署单元修正**：`Environment` 增 `MATH_DRILL_TOKEN_FILE`；增 `StateDirectory=math-drill`（自动创建 `/var/lib/math-drill` 并从 `ProtectSystem` 豁免，不再留给 T7 现场手工 mkdir）；`data_dir` 单源留在 `config/server.toml`，删除 `MATH_DRILL_DATA` env（消除双源）。
  4. **B4 会话派生**：`md_session = HMAC-SHA256(key=token, msg="md-session-v1")`，每请求重算并用 `hmac.compare_digest` 校验——**零存储**，使「轮换 token ⇒ 旧 cookie 失效」第一次真正成立。
  5. **C 类**：限速语义写死（按来源 IP / 固定窗口 / **只计失败** / 成功清零 / 重启清零，参数统一整数+秒）；上游 pin = `82c014479f712a88b43fc147ab92d824c0ccc784`；§3.5 标注真值归 `contracts/blob_merge.md`。
  6. **T7 验收 6 → 12 项**：补「Caddy 改动=纯追加 diff」「`caddy validate` 先于 reload」「禁止 `docker compose up -d`」「既有站点走 https 公网面各 200」「回滚 sha256 校验」「timer 对照 + 备份手动触发」「DNS 解析核对」。
  7. **第 5 条同类问题（落笔自检发现）**：`patches/` 被 ADR-006 与 §10.1 引用，却不在 §11.9 真值树里——而树的纪律 1 又规定「不得新增顶层域」，照树施工的 T0 无处安放 fork 补丁。已把 `patches/`（Phase 1 空占位目录）与 `references/` 一并补进顶层域清单。这条是「树 ↔ 契约双向映射」自检抓到的，非第三方提出。
- **代价（承认）**：① 修正批自身有引入新矛盾的风险（v2.6 已实证一次），故此后每批交付前必须过**「树 ↔ 契约双向映射」**（每个契约引用的路径都要在树里出现；树里每个文件都要有契约出处）② T7 验收项翻倍，部署当日耗时增加——换取的是「只追加」从口号变成**机器可判**的性质 ③ 派生式会话无法按设备撤销（N=1 无差异；多设备需求出现时再补 ADR）。
- **驳回记录（诚实）**：质检官 B3(b)「`ProtectSystem=strict` 下写不了 `append:` 日志」经实测**不成立**——该 fd 由 PID 1 在单元命名空间之外打开（`man 5 systemd.exec`："opened by the service manager before the executable is invoked"）。`LogsDirectory=math-drill` 保留为「应用日后自写日志」情形下的备选，**不**作为故障修复。
- **裁判**：决策人（本轮指派复核者直接落笔；与「施工方不改自己要被验收的规格」的既有纪律的偏离，记录在案供审计）

### ADR-012 · v2.8 追加（第四轮第三方复核：2 阻塞 + 13 清单，全修）

- **背景**：v2.7 提交第三方冷启动复核，判定「9 处锚点无一处写错位置」但报出 **2 条阻塞** 与 **13 条清单**。
  阻塞两条都属同型回归——**改了主真值没回扫引用方与兄弟项**（本项目第 3、第 4 次）：
  ① §12.1 `ExecStart` 带 `--host/--port` 而 §13.1 声明 `server.toml` 是绑定/端口真源 → **端口双源**（同 data_dir 那一类，纪律只执行了一半）；
  ② 施工单 T3 验收仍写「全部路由过统一 token 门（无例外面）」，与 §11.5/§13.2/§13.3 的 `/setup` 例外**字面不可满足**（v2.7 变更 #2 的第三处漏扫）。
- **决策（修正内容）**：
  1. **端口单源**：`ExecStart` 去掉 `--host/--port`（原 `/usr/bin/python3 -m bridge.api --host 127.0.0.1 --port 8081`）；绑定 / 端口 / `data_dir` 一律以 `config/server.toml` 为准，**无 CLI / env 覆盖**。
  2. **施工单 T3 验收**改为「除引导端点 `/setup` 外全部过门」，并补静态面匿名只读、越权路径 403，以及限速可测（超 `api_per_minute` → 429）。
  3. **静态面与鉴权次序写死**：静态面**不过 token 门**（匿名可读）；次序 = 先路径合法性（越权 → 403）后鉴权（`/api/*`、`/m/*` 无 cookie → 401）。依据是 403 与 401 的验收期望不能同时成立。同时删掉 §1 威胁模型里「见 §7 开放」的悬空指针。
  4. **T3 凭据注入规格**：测试在临时目录生成一次性 token 文件 + monkeypatch `MATH_DRILL_TOKEN_FILE`；必须覆盖「env 缺失 → 拒启 / 文件为空 → 拒启 / token 不匹配 → 401」三条。这是 H7（凭据不入夹具）与「缺失拒启」之下**唯一合规解**。
  5. **真值树补漏**：`core/exact/__init__.py`（导出面——实测无它则 `from core.exact import det` 报 ImportError，而 P1 钦定的正是这个写法）、`tests/test_registry.py`（MODULE_TEMPLATE 第 7 步要求，第 2 轮已报未闭合）、顶层域清单补 `data/`、仓库文件清单补 `.gitignore`、`deploy/logrotate.d/math-drill`。
  6. **Ch2–Ch6 省略号**改为「Phase 1 不预建，P4 按需新增」——消除 T0 目录清单的不可判定。
  7. **建表与 schema_version 归属**明确落在 `core/store.py`（铁律 3：持久层在 core，模块不建表）；灌库脚工具名为 `scripts/db_init.py --load-bundle`，T6 补「落库后 `questions` ≥40 行」验收，T7 补「部署前置」。
  8. **logrotate 残值**（承 v2.7 驳回的正确性）：`append:` 靠 fd 继承工作 ⇒ 轮转**必须 `copytruncate`**（默认 `create` 式会让进程继续写旧 inode，新日志静默不增长）；片段入树、入 §12.1、并加 §12.4 ⑪b 验收。
  9. **references/ 与 H8 的冲突**：`references/` 改为 **`.gitignore` 排除、不入版本控制**（与 `data/` 同待遇）——不进仓库即不进远端，H8 不动。
  10. **真值占位化**：T0 明确 `contracts/blob_merge.md`（搬运 §3.5）与 `contracts/events.py`（枚举骨架+命名规则）**不是空壳**；`tests/test_dep_rules.py`、`tests/test_registry.py` 同为 T0 实产。
- **代价（承认）**：① 本批 15 处改动全部是"消歧/补漏"，**零设计结论变更**——但也说明文档的收敛靠的是"改一批、被扫一遍"的循环，而不是一次写全，这是本文档集目前的真实成本结构 ② T7 验收增至 13 项（含 ⑪b），部署当日更长 ③ `references/` 不入版本控制后，"调研材料随仓走"的能力放弃，换 H8 的字面一致性。
- **裁判**：决策人（指派复核者落笔）；第三方复核（冷启动 + 定点交叉，两路径发现面不同，故两路都留）

### ADR-012 · v2.9 追加（第四轮定点复核：3 条同型回归 + refcheck 立项）

- **背景**：v2.8 之后第三方做了一轮**定点复核**（非全量：约 10 次 grep + 读 `DECISIONS.md` 全文，未通读、未改任何文件）。结论：**两条阻塞确实消了、抽查的 8 处修复落地正确**，但修复批自己又制造 3 条同型回归——**第 4、5、6 次同型**，其中最刺眼的一条是**账本本身漏记**（`ARCHITECTURE-v2.md` 的 v2.8 变更行写「2 阻塞 + 6 清单」，而 ADR 写「13 清单，全修」；行内只列了前 6 条，logrotate 这个本轮唯一的安全残值没进账本）。
- **决策**：
  1. **账本更正**：v2.8 行表头改为「2 阻塞 + 13 清单」并加指针（"逐条见 `DECISIONS.md` ADR-012 · v2.8 追加"），**不重抄 15 条**——原行长 994 字节，重抄必错。
  2. **`tests/test_registry.py` 从 `[T0]` 改标 `[T3]`**：被测对象 `core/registry.py` 是 T3 产出（`IMPLEMENTATION_BRIEF.md` T3 产出栏），T0 时它只有一行职责注释 ⇒ 原写法三解（越界 / 空壳 / 红）。`tests/test_dep_rules.py` 保持 `[T0]`（AST 扫桩真能绿），两者**不再并列**。
  3. **`data_dir` 注释消歧**：「开发态可覆盖」→「就改本文件这一行（无 env / CLI 覆盖）」，与 §13.1 的单源口径对齐（这是刚修完的清单⑦"可覆盖无机制"的同一句式，上一批扫了⑦没扫它）。
  4. **新增 `ARCHITECTURE §14`：`scripts/refcheck.py` 立项**——三类机械检查（C1 树↔契约双向、C2 同值多定义、C3 自陈数字），内置豁免表（历史留档旧名 + 宿主态路径白名单），**验收含三类负例自测**，调用时机 = 改完 `docs/` 之后 + 每轮交付前。归属与实现都落在执行方（T0 交付）。
- **代价（承认）**：① 护栏本身是新文件、新契约面，若不做负例自测就会变成第 14 个"空壳"——故把"能红"写成硬验收 ② 护栏只覆盖**机械可判定**的错（引用、单源、数字），设计层的错仍要靠人 ③ 定位为"评审判据、执行方实现"，避免继续累积"评审直接落笔"的偏离记录。
- **裁判**：第三方定点复核（本轮）出判据；护栏实现归执行方（T0）；决策人确认"做"及其四条条件
