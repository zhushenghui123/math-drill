/**
 * 客户端半边（Phase B）：在**追加型**槽位 `conversation.input.dock` 里放一条考研数学状态条。
 *
 * 三条设计约束（都来自 ADR-015）：
 *  ① **追加，不替换**（决策 6）：`conversation.input.dock` 是 `list` 型槽位，我们只 `register` 一条，
 *     不碰任何官方组件；`single` 型槽位（会顶掉官方组件）一律不用。
 *  ② **浏览器里没有凭据**：面板只 `fetch('/math-drill/summary')` —— 那是**宿主半边**自己挂的只读路由，
 *     凭据留在宿主进程里（`src/credential.js`），永远不进浏览器。
 *  ③ **不用 JSX**：产物这条管线（tsdown/rolldown）的手写配置要额外管 jsx runtime 的解析；
 *     我们只需要一个小条幅，`createElement` 足够，少一个会腐烂的配置维度。
 *
 * @module @math-drill/dsh-plugin/client
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { createElement as h, useCallback, useEffect, useState } from 'react'

/** 宿主半边挂的只读摘要路由（见 src/index.js）。 */
const SUMMARY_PATH = '/math-drill/summary'

/** 本插件需要的浏览器服务：只要槽位（不碰 locale / store / remote）。 */
export const inject = ['slots']

/** 槽位注册的 id（同一槽位里与官方/其他插件的条目共存靠它区分）。 */
const SLOT_ID = 'math-drill'

/** 摘要响应的形状（宿主半边定义真源）。 */
type SummaryResponse =
  | { ok: true; text: string; fetchedAt: number }
  | { ok: false; error: string }

const BOX_STYLE = {
  display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
  padding: '4px 10px', margin: '0 0 4px', borderRadius: '8px',
  border: '1px solid var(--dsh-border, rgba(128,128,128,0.35))',
  fontSize: '12px', lineHeight: '1.5', opacity: 0.92,
} as const

const LABEL_STYLE = { fontWeight: 600, whiteSpace: 'nowrap' } as const
const TEXT_STYLE = { whiteSpace: 'pre-wrap', flex: '1 1 240px' } as const
const BUTTON_STYLE = {
  border: '1px solid currentColor', background: 'transparent', color: 'inherit',
  borderRadius: '6px', padding: '1px 8px', fontSize: '12px', cursor: 'pointer', opacity: 0.8,
} as const

/**
 * 状态条组件：挂载时拉一次摘要，点「刷新」再拉。
 *
 * 失败**不抛**：把宿主回的可操作消息原样显示（没配凭据就是提示怎么配），
 * 这样面板本身就是"怎么把它配起来"的说明书。
 */
function MathDrillDock() {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'ready'; text: string } | { kind: 'failed'; message: string }
  >({ kind: 'loading' })

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' })
    try {
      const response = await fetch(SUMMARY_PATH, { headers: { Accept: 'application/json' } })
      const payload = await response.json() as SummaryResponse
      setState(payload.ok
        ? { kind: 'ready', text: payload.text }
        : { kind: 'failed', message: payload.error })
    } catch (error) {
      setState({ kind: 'failed', message: `取不到考研数学摘要：${error instanceof Error ? error.message : String(error)}` })
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const body = state.kind === 'loading'
    ? '读取中…'
    : state.kind === 'ready' ? state.text : `⚠️ ${state.message}`

  return h('div', { style: BOX_STYLE, 'data-math-drill': 'dock' },
    h('span', { style: LABEL_STYLE }, '考研数学'),
    h('span', { style: TEXT_STYLE }, body),
    h('button', { type: 'button', style: BUTTON_STYLE, onClick: () => { void load() } }, '刷新'),
  )
}

/**
 * 挂载客户端半边：往 `conversation.input.dock` 追加一条。
 *
 * @param ctx - DSH 客户端上下文（cordis）。
 */
export function apply(ctx: { slots: { inject: (name: string, factory: () => unknown) => void; register: (options: Record<string, unknown>, component: unknown) => unknown } }): void {
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: SLOT_ID,
    order: 20,
  }, MathDrillDock))
}
