# 第三方与红线清单

## 继承的第三方

| 组件 | 来源 | 许可 | 处置 |
|---|---|---|---|
| kaoyan-math-tutor（fork 基线） | 111wukong | MIT | 继承，见 `ATTRIBUTION`（含 commit pin） |
| KaTeX（前端公式渲染） | 上游随附 | MIT | 随 fork 继承 |

## 明确排除

- ⛔ **GPL / AGPL 代码不得引入**（只可借鉴思路，不可抄码）——H9。
  （调研中出现的 GPL-3.0 / AGPL-3.0 项目仅作参照。）

## 数据红线（两条，均为硬约束）

1. **真题 / 书稿 OCR 内容一律不入仓**（含测试样本）——H8。
   开源仓里只允许：我方生成器产物 + 用户自备 `custom_json` 示例（合成样例）。
   带 provenance 的 OCR 资产停在本地 / 私有备份；`references/` 已在 `.gitignore` 中。
2. **任何 API key / token / 密码永不入仓**——H7。
   LLM key 由用户在客户端自持；服务端 token 落 `/etc/math-drill/token`（600），
   路径经 systemd 注入，**不落盘进仓库**。

## 服务端依赖

服务端为**纯 Python 3.12 stdlib**（H1 / ADR-005）：`http.server` + `sqlite3` +
`json` + `fractions` + `tomllib`。测试用 `unittest`。**无第三方运行期依赖。**
