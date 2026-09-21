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
export const MATH_DRILL_TOOL_NAMES = [
  'math_drill_progress', 'math_drill_today', 'math_drill_review', 'math_drill_set_difficulty',
]

/**
 * 其中**会改变服务端状态**的工具名 —— 白名单真值（ADR-018 代价 2）。
 *
 * ⚠️ 这两个常量是配套的：写面从"结构性没有"降级成"可枚举"以后，**这个数组就是新的护栏**，
 * 测试里断言它恰好等于 `['math_drill_set_difficulty']`。想加第二个写工具 = 先立 ADR。
 */
export const MATH_DRILL_WRITE_TOOL_NAMES = ['math_drill_set_difficulty']

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
 * @param {object} options.client - 服务客户端（读方法 + 白名单里的写方法）。
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

  // ⚠️ 本插件**唯一**会改服务端状态的工具（ADR-018）。其余全部只读。
  const setDifficulty = defineTool({
    name: 'math_drill_set_difficulty',
    description:
      '把**你（agent）判定的题目难度**写进研数题库，之后控制台上这道题就按你写的难度显示。'
      + '难度取值 1=入门 2=基础 3=进阶 4=挑战。'
      + '**什么时候用**：和用户实际讨论过这道题之后 —— 你或用户觉得题库标的难度不对，再改；'
      + '不要仅凭题面扫一眼就批量刷。**题库原生难度不会被覆盖**（服务端 append-only 留痕，'
      + '以最后一次写入为准），所以改错了可以再改回去。'
      + '`reason` 请写成人话（一句话说清为什么是这个难度），它会显示在题目详情里给用户看。',
    parameters: {
      qid: { type: 'string', description: '题号（如 lin.det.05ea473736a6）。' },
      difficulty: { type: 'number', description: '难度：1=入门 2=基础 3=进阶 4=挑战。' },
      reason: { type: 'string', description: '一句话理由（会显示在题目详情里）。' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const qid = String(args?.qid ?? '').trim()
      const raw = Number(args?.difficulty)
      if (!qid) throw new Error('需要 qid（题号）')
      if (!Number.isInteger(raw) || raw < 1 || raw > 4) throw new Error('difficulty 必须是 1-4 的整数')
      const out = await client.setDifficulty(qid, raw, args?.reason ? String(args.reason) : undefined)
      const label = ['', '入门', '基础', '进阶', '挑战'][raw]
      const base = out?.difficultyBase == null ? '题库原本没标难度' : `题库原生标注 ${out.difficultyBase}/4`
      return { text: `已记下：${qid} 的难度 = ${label}（${raw}/4）—— ${base}，现在以你的判定为准。` }
    },
    presentCall: () => ({ title: '标注题目难度', kind: 'edit' }),
  })

  return [progress, today, review, setDifficulty]
}
