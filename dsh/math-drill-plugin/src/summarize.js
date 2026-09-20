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
  // ⚠️ 方向校正（2026-09-20 决策人）：**DSH 不是题目的第二展示面** —— 题目/做题/解析都在研数控制台。
  // 所以这里**只回数据**（数量 / 考点 / 难度分布 / 题号 / 题型），**不回题面**：
  // agent 拿这些数据就够用来"陪你复盘、点出薄弱考点"，要看题请回控制台。
  const kids = new Map()
  const difficulties = new Map()
  const types = new Map()
  for (const raw of questions) {
    const q = stripQuestionAnswers(raw)
    const kid = String(q.kid ?? '（未标注考点）')
    kids.set(kid, (kids.get(kid) ?? 0) + 1)
    const difficulty = String(q.difficulty ?? '?')
    difficulties.set(difficulty, (difficulties.get(difficulty) ?? 0) + 1)
    const type = String(q.type ?? '?')
    types.set(type, (types.get(type) ?? 0) + 1)
  }
  const fmt = (map) => [...map.entries()].map(([key, count]) => `${key}×${count}`).join('、')
  return [
    `今日题单（server_version=${payload?.server_version ?? 0}）：**${questions.length} 题**`,
    `· 考点：${fmt(kids)}`,
    `· 难度：${fmt(difficulties)}`,
    `· 题型：${fmt(types)}`,
    `· 题号：${questions.map((q) => String(q?.id ?? '?')).join('、')}`,
    '（**题面与答案都不在本输出内**：看题、做题、判分都在研数控制台；这里只提供"该练什么"的数据。）',
  ].join('\n')
}

/**
 * `/api/attempts` + `/api/kp` → 复盘文本（agent 用；**不含题面与答案**）。
 *
 * 为什么要 kp：`attempts` 里只有 `kid`（`l1n1` 这种）——没有目录，agent 只能说
 * "你在 l1n1 上错得多"，说不出人话（评审第四轮：kp 是 attempts 的**依赖**，不是偏好）。
 *
 * @param {Record<string, any>} attempts - `/api/attempts` 的响应。
 * @param {Record<string, any>} kp - `/api/kp` 的响应。
 * @returns {string} 给模型看的短文本。
 */
export function summarizeReview(attempts, kp) {
  const titles = new Map((kp?.items ?? []).map((item) => [String(item.id), String(item.title ?? item.id)]))
  const totals = attempts?.totals ?? {}
  const days = attempts?.window?.days ?? '?'
  if (!totals.n) return `近 ${days} 天没有做题记录（或者还没点开学控制台）。`
  const lines = [
    `近 ${days} 天：做 ${totals.n} 题，对 ${totals.correct}、错 ${totals.wrong}`
    + `（正确率 ${totals.accuracy === null || totals.accuracy === undefined ? '—' : Math.round(totals.accuracy * 100) + '%'}）`,
  ]
  const weak = (attempts.byKid ?? []).filter((row) => row.wrong > 0).slice(0, 3)
  if (weak.length > 0) {
    lines.push('最该复习的考点：' + weak.map((row) =>
      `${titles.get(String(row.kid)) ?? row.kid}（错 ${row.wrong}/${row.n}）`).join('、'))
  }
  const recentWrong = (attempts.recent ?? []).filter((row) => row.correct === false).slice(-5)
  if (recentWrong.length > 0) {
    lines.push('最近的错题：' + recentWrong.map((row) =>
      `${row.day} ${titles.get(String(row.kid)) ?? row.kid} [${row.qid}]`).join('；'))
  }
  lines.push('（题面与答案不在本输出内：看题、改错、判分都在研数控制台；这里只给"该补哪儿"的线索。）')
  return lines.join('\n')
}

/**
 * 状态条下方那组**小组件**的数据面（一次算好，客户端只管画）。
 *
 * 依据决策人 2026-09-20 的定调：**DSH 不是题目的第二展示面**，插件只做"数据桥 + 几个小组件"。
 * 每个字段都对应一个能一眼看懂的小组件，且**全部来自只读数据**（blob + /api/attempts + /api/kp）。
 *
 * @param {Record<string, any>} state - `/api/state` 的响应。
 * @param {Record<string, any>} attempts - `/api/attempts` 的响应。
 * @param {Record<string, any>} kp - `/api/kp` 的响应。
 * @param {Date} [now] - 注入"今天"。
 * @returns {Record<string, any>} 见下面各字段的注释。
 */
export function summarizeWidgets(state, attempts, kp, now = new Date()) {
  const data = state?.data ?? {}
  const daily = data.daily ?? null
  const settings = data.settings ?? {}
  const game = data.game ?? {}
  const checkins = data.checkins ?? {}
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const span = (ids, done) => ({ done: countOf(done), total: countOf(ids) })
  const titles = new Map((kp?.items ?? []).map((i) => [String(i.id), String(i.title ?? i.id)]))

  // ① 今日三栏（新学 / 复习 / 小测）
  const todayWidget = daily
    ? { new: span(daily.newIds, daily.newDoneIds), review: span(daily.reviewIds, daily.reviewDoneIds), quiz: span(daily.quizIds, daily.quizDoneIds) }
    : null

  // ② 弱项考点 Top3（用知识点目录把 kid 翻成人话）
  const weak = (attempts?.byKid ?? [])
    .filter((row) => row.wrong > 0)
    .slice(0, 3)
    .map((row) => ({
      kid: row.kid, title: titles.get(String(row.kid)) ?? String(row.kid),
      n: row.n, wrong: row.wrong, accuracy: row.accuracy,
    }))

  // ③ 考点覆盖（练过几个 / 共几个）
  const covered = new Set((attempts?.byKid ?? []).map((row) => String(row.kid))).size
  const coverage = { covered, total: (kp?.items ?? []).length }

  // ④ 连续打卡 + 游戏化（研数自己有 gamifier 模块，这里只读它的状态）
  const streak = (() => {
    let n = 0
    const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    for (;;) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
      if (checkins[key] === undefined) break
      n += 1
      cursor.setDate(cursor.getDate() - 1)
    }
    return n
  })()
  const gameWidget = {
    streak,
    minutesToday: checkins[today]?.minutes ?? 0,
    combo: Number(game.combo ?? 0),
    bestCombo: Number(game.bestCombo ?? 0),
    achievements: Object.keys(game.achievements ?? {}).length,
  }

  // ⑤ 目标倒计时（settings 为空时显式给 null —— 客户端据此显示"让 agent 帮你设"）
  const daysLeft = settings.examDate ? daysUntil(settings.examDate, now) : null
  const target = settings.examDate
    ? { examDate: settings.examDate, daysLeft, track: TRACK_NAMES[settings.examTrack] ?? null, dailyNew: settings.dailyNew ?? null }
    : null

  return { today: todayWidget, weak, coverage, game: gameWidget, target }
}
