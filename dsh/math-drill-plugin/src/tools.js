/**
 * agent 面向的**只读**工具（ADR-015 决策 1/5）—— 接线层。
 *
 * 两条红线在代码里落地，不靠自觉：
 *  ① **答案不进上下文**：见 `summarize.js` 的 `stripQuestionAnswers`
 *     （agent 在讲解侧，不在答案侧：ADR-013 的定位 + ADR-015 决策 5）；
 *  ② **凭据不进输出**：见 `credential.js`（不落日志、不回显）。
 *
 * 纯函数在 `summarize.js`（无 harness 依赖 ⇒ 仓库内可直接跑测试）；
 * 本模块只做 `defineTool` 包装。
 *
 * @module @math-drill/dsh-plugin/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { summarizeDaily, summarizeProgress, summarizeReview } from './summarize.js'

/** 本插件注册的工具名（顺序即呈现顺序）。 */
export const MATH_DRILL_TOOL_NAMES = ['math_drill_progress', 'math_drill_today', 'math_drill_review']

/** 统一文本输出契约（沿用 bridge-browser 同款：一个 `{ text }` 对象 = 一个文本块）。 */
const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true } },
  },
  render: (_args, value) => [{ type: 'text', text: String(/** @type {{text?: unknown}} */ (value)?.text ?? '') }],
}

/**
 * 造两个只读工具定义（调用方用 `ctx.tools.register` 注册）。
 *
 * @param {object} options
 * @param {{ state: () => Promise<object>, daily: () => Promise<object> }} options.client - 只读客户端。
 * @returns {import('@deepseek-ai/dsh-tools').ToolDefinition[]}
 */
export function createMathDrillTools({ client }) {
  const progress = defineTool({
    name: 'math_drill_progress',
    description:
      '读取考研数学练题系统的进度：考试轨道、目标考试日期与剩余天数、今日题单完成情况、'
      + '打卡与知识卡片数。只读；不参与判分。用于回答"我学到哪了/今天还差什么"这类问题。',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute() {
      return { text: summarizeProgress(await client.state()) }
    },
    presentCall: () => ({ title: '读取考研数学进度', kind: 'read' }),
  })

  const today = defineTool({
    name: 'math_drill_today',
    description:
      '读取考研数学**今天该练什么**的清单数据：题数、考点分布、难度分布、题型分布、题号。'
      + '**不回题面、不回答案** —— 看题/做题/判分都在研数控制台，本工具只提供"该练什么"的数据，'
      + '用于陪用户复盘、点出薄弱考点。',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute() {
      return { text: summarizeDaily(await client.daily()) }
    },
    presentCall: () => ({ title: '读取今日题单', kind: 'read' }),
  })

  const review = defineTool({
    name: 'math_drill_review',
    description:
      '复盘考研数学最近一段时间的做题表现：题数/对错/正确率、**最该复习的考点**（用知识点目录把 kid 翻成人话）、'
      + '最近的错题清单（日期 + 考点 + 题号）。**不回题面与答案** —— 看题/改错/判分都在研数控制台。',
    parameters: {
      days: { type: 'number', description: '回看天数（默认 30，1–365）。' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const days = Math.max(1, Math.min(365, Number(args?.days ?? 30) || 30))
      const [attempts, kp] = await Promise.all([client.attempts(days), client.kp()])
      return { text: summarizeReview(attempts, kp) }
    },
    presentCall: () => ({ title: '复盘考研数学', kind: 'read' }),
  })

  return [progress, today, review]
}
