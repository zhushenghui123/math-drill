/**
 * 纯函数核：把 math-drill 的响应压成给模型看的短文本。
 *
 * **为什么单独一个模块**：这里没有一行 harness 依赖 ⇒ 可以在仓库内用 `node --test`
 * 直接跑（不需要先装进 DSH profile）。红线（**答案不进模型上下文**）的机械护栏就落在这里。
 *
 * @module @math-drill/dsh-plugin/summarize
 */

const TRACK_NAMES = { math1: '数学一', math2: '数学二', math3: '数学三' }

/**
 * 剥掉题目里的答案与解析（红线：agent 在讲解侧，不在答案侧）。
 *
 * `/api/daily` 的响应带着 `answer`/`analysis`（服务端为前端判分准备的），
 * 若原样进上下文，agent 就有能力直接报答案 —— 那不是"讲解侧"。
 *
 * @param {Record<string, unknown>} question - 题目对象。
 * @returns {Record<string, unknown>} 不含 `answer` / `analysis` 的副本。
 */
export function stripQuestionAnswers(question) {
  const { answer: _answer, analysis: _analysis, ...rest } = question ?? {}
  return rest
}

/**
 * 距目标日期还有几天（非法/空值返回 null）。
 *
 * @param {unknown} dateText - `YYYY-MM-DD`。
 * @param {Date} [now] - 注入"今天"（测试用）。
 * @returns {number | null}
 */
export function daysUntil(dateText, now = new Date()) {
  if (typeof dateText !== 'string' || dateText === '') return null
  const target = Date.parse(`${dateText}T00:00:00`)
  if (Number.isNaN(target)) return null
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return Math.round((target - midnight) / 86_400_000)
}

/** 数组长度（非数组算 0）。 */
const countOf = (value) => (Array.isArray(value) ? value.length : 0)

/**
 * 把题面里的**裸 LaTeX 环境**包成 markdown 数学定界符，让客户端渲染成真公式。
 *
 * 为什么需要：题库里的题面是数学式与中文混排，`\begin{vmatrix}…\end{vmatrix}` 是**裸的**
 * （没有 `$` / `$$`），markdown 渲染器不会把它当数学 ⇒ 用户看到一串反斜杠。
 * 包成 `$$…$$` 后由官方渲染件（`ui-primitives` 的 `MarkdownText`，内置 KaTeX）画成公式。
 *
 * @param {unknown} text - 题面原文。
 * @returns {string} 包裹后的文本。
 */
export function toMarkdownMath(text) {
  return String(text ?? '').replace(
    /\\begin\{([a-zA-Z*]+)\}[\s\S]*?\\end\{\1\}/g,
    (match) => `$$${match}$$`,
  )
}

/**
 * `/api/state` 的 blob → 短文本。
 *
 * @param {Record<string, any>} blob - `{ server_version, data }`。
 * @param {Date} [now] - 注入"今天"（测试用）。
 * @returns {string}
 */
export function summarizeProgress(blob, now = new Date()) {
  const data = blob?.data ?? {}
  const settings = data.settings ?? {}
  const daily = data.daily ?? null
  const checkins = data.checkins ?? {}
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const checkin = checkins[today] ?? null

  const lines = [
    `math-drill 进度（server_version=${blob?.server_version ?? 0}）`,
    `轨道：${TRACK_NAMES[settings.examTrack] ?? settings.examTrack ?? '未设置'}`,
  ]
  if (settings.examDate) {
    const days = daysUntil(settings.examDate, now)
    lines.push(`目标考试：${settings.examDate}${days === null ? '' : `（还有 ${days} 天）`}`)
  }
  if (daily) {
    lines.push(
      `今日题单（${daily.date}）：复习 ${countOf(daily.reviewDoneIds)}/${countOf(daily.reviewIds)}，`
      + `新学 ${countOf(daily.newDoneIds)}/${countOf(daily.newIds)}，`
      + `小测 ${countOf(daily.quizDoneIds)}/${countOf(daily.quizIds)}`,
    )
  } else {
    lines.push('今日题单：还没有（网页端今天还没打开过）')
  }
  lines.push(`打卡：${checkin ? `${checkin.minutes ?? 0} 分钟${checkin.tasksDone ? '，任务已完成' : ''}` : '今天还没打卡'}`)
  lines.push(`知识卡片：${Object.keys(data.cards ?? {}).length} 张；笔记：${Object.keys(data.notes ?? {}).length} 条`)
  lines.push('（本工具只读；作答与判分在网页端，agent 不参与判定链路）')
  return lines.join('\n')
}

/**
 * `/api/state` 的 blob → **一行**简报（给状态条用；明细留给 `/math` 与卡片）。
 *
 * 为什么单独一条：状态条是常驻的窄条，塞多行正文会把输入区顶开、也难扫
 * （对标物 `statusbar-config` / `lookatstudy` 都是"一行状态丸 + 明细在别处"的形态）。
 *
 * @param {Record<string, any>} blob - `{ server_version, data }`。
 * @param {Date} [now] - 注入"今天"（测试用）。
 * @returns {string} 无换行的一行。
 */
export function summarizeBrief(blob, now = new Date()) {
  const data = blob?.data ?? {}
  const settings = data.settings ?? {}
  const daily = data.daily ?? null
  const checkins = data.checkins ?? {}
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const checkin = checkins[today] ?? null

  const parts = []
  if (daily) {
    const total = countOf(daily.reviewIds) + countOf(daily.newIds) + countOf(daily.quizIds)
    const done = countOf(daily.reviewDoneIds) + countOf(daily.newDoneIds) + countOf(daily.quizDoneIds)
    parts.push(`⚡ 今日 ${done}/${total}`)
  } else {
    parts.push('⚡ 今日未开局')
  }
  if (settings.examDate) {
    const days = daysUntil(settings.examDate, now)
    if (days !== null) parts.push(`🎯 还有 ${days} 天`)
  }
  if (checkin) parts.push(`🔥 ${checkin.minutes ?? 0} 分钟`)
  const track = TRACK_NAMES[settings.examTrack]
  if (track) parts.push(track)
  return parts.join(' · ')
}

/**
 * `/api/daily` 的响应 → 短文本（**已剥答案**）。
 *
 * @param {Record<string, any>} payload - `{ server_version, daily, questions }`。
 * @returns {string}
 */
export function summarizeDaily(payload) {
  const questions = Array.isArray(payload?.questions) ? payload.questions : []
  if (questions.length === 0) return '今天服务端没有出题（题库为空，或还没灌库）。'
  const lines = [`今日题单（server_version=${payload?.server_version ?? 0}，共 ${questions.length} 题）`]
  for (const [index, raw] of questions.entries()) {
    const q = stripQuestionAnswers(raw)
    const options = Array.isArray(q.options) ? `｜选项 ${JSON.stringify(q.options)}` : ''
    const stem = toMarkdownMath(String(q.stem ?? '').replace(/\s+/g, ' ').trim())
    lines.push(`${index + 1}. [${q.kid ?? '?'} / ${q.id}] 难度 ${q.difficulty ?? '?'}｜${stem}${options}`)
  }
  lines.push('（**答案与解析不在本输出内**：agent 只陪讲解与思路，判分由服务端 judge 负责）')
  return lines.join('\n')
}
