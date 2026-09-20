/**
 * 状态条下方的**小组件面板**（决策人定调：DSH 只做"数据桥 + 几个小组件"，不做题目展示面）。
 *
 * 渲染件全部来自平台表内模块（`ui-primitives` 的 `DisclosureRow` / `Pill` / `MarkdownText`）；
 * 样式只用语义 token（`--dsw-alias-*`），不写颜色字面量（`docs/web-styling`）。
 *
 * 每个组件都对应 `summarizeWidgets()` 的一个字段（真源在宿主侧，客户端不自己算）。
 *
 * @module @math-drill/dsh-plugin/client/widgets
 */

import { DisclosureRow, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement as h, useState } from 'react'

/** 小组件数据（= `summarizeWidgets()` 的返回）。 */
export interface MathDrillWidgetsData {
  today?: Record<string, { done: number, total: number }> | null
  weak?: { kid: string, title: string, n: number, wrong: number, accuracy: number | null }[]
  coverage?: { covered: number, total: number }
  game?: { streak: number, minutesToday: number, combo: number, bestCombo: number, achievements: number }
  target?: { examDate: string, daysLeft: number | null, track: string | null, dailyNew: number | null } | null
}

const PANEL = {
  border: '0.5px solid var(--dsw-alias-border-l2)',
  borderTop: '0',
  borderRadius: '0 0 10px 10px',
  padding: '8px 12px 10px',
  margin: '0 0 6px',
  fontSize: '12px',
  display: 'grid',
  gap: '8px',
} as const

const ROW = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } as const
const MUTED = { opacity: 0.75 } as const

/** 一条细进度条（宽度按 done/total，用 token 色）。 */
function bar(done: number, total: number) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100)
  return h('span', {
    style: {
      display: 'inline-block', width: '72px', height: '6px', borderRadius: '999px',
      background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))', overflow: 'hidden',
    },
  }, h('span', {
    style: {
      display: 'block', width: `${pct}%`, height: '100%',
      background: 'var(--dsw-alias-brand-primary)',
    },
  }))
}

/**
 * 渲染小组件面板。
 *
 * @param props - `widgets`（宿主算好的数据）+ `t`（文案座位，可选）。
 * @returns React 元素。
 */
export function MathDrillWidgets(props: MathDrillWidgetsData & { t?: (key: string) => string }) {
  const [open, setOpen] = useState(true)
  const w = props
  const tr = (key: string, fallback: string): string =>
    typeof props.t === 'function' ? props.t(key) : fallback
  const today = w.today
  const cov = w.coverage
  const game = w.game

  return h(DisclosureRow, {
    icon: h(Pill, { active: false }, '📊'),
    title: tr('widgets.title', '考研数学 · 小组件'),
    open,
    expandable: true,
    onToggle: () => { setOpen((v) => !v) },
    expandOnRowClick: true,
  },
  h('div', { style: PANEL },
    // ① 今日三栏
    today === null || today === undefined
      ? h('div', { style: MUTED }, tr('widgets.noDaily', '今天还没开局 —— 去控制台点开今日题单'))
      : h('div', { style: ROW },
          ...['new', 'review', 'quiz'].map((key) => {
            const slot = today[key] ?? { done: 0, total: 0 }
            return h('span', { key, style: ROW },
              h('span', { style: MUTED }, tr(`widgets.${key}`, ({ new: '新学', review: '复习', quiz: '小测' } as Record<string, string>)[key])),
              bar(slot.done, slot.total),
              h('span', null, `${slot.done}/${slot.total}`),
            )
          }),
        ),
    // ② 考点覆盖
    cov === undefined ? null : h('div', { style: ROW },
      h('span', { style: MUTED }, tr('widgets.coverage', '考点覆盖')),
      bar(cov.covered, cov.total),
      h('span', null, `${cov.covered}/${cov.total}`),
    ),
    // ③ 弱项 Top3（人话标题来自知识点目录）
    (w.weak ?? []).length === 0 ? null : h('div', { style: ROW },
      h('span', { style: MUTED }, tr('widgets.weak', '最该复习')),
      ...(w.weak ?? []).map((row) => h('span', { key: row.kid, style: ROW },
        h('span', null, row.title),
        h('span', { style: MUTED }, `错 ${row.wrong}/${row.n}`),
        h('span', { style: MUTED }, `${row.accuracy === null ? '—' : Math.round(row.accuracy * 100) + '%'}`),
      )),
    ),
    // ④ 打卡 + 游戏化
    game === undefined ? null : h('div', { style: ROW },
      h('span', null, `🔥 ${game.streak} 天`),
      h('span', { style: MUTED }, `⏱ 今天 ${game.minutesToday} 分钟`),
      h('span', null, `🏆 ${game.achievements}`),
      h('span', { style: MUTED }, `⚡ 最高连击 ${game.bestCombo}`),
    ),
    // ⑤ 目标倒计时（未设置时是"入口"，不是空白）
    h('div', { style: ROW },
      w.target === null || w.target === undefined
        ? h('span', { style: MUTED }, tr('widgets.noTarget', '还没设考试目标 —— 让 agent 帮你设（说一句"我 12 月考，目标是数学一"）'))
        : h('span', null,
            `🎯 ${w.target.examDate}${w.target.daysLeft === null ? '' : ` · 还有 ${w.target.daysLeft} 天`}`
            + `${w.target.track === null ? '' : ` · ${w.target.track}`}`
            + `${w.target.dailyNew === null ? '' : ` · 建议每日 ${w.target.dailyNew} 题`}`),
    ),
  ))
}
