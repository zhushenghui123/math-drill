/**
 * `math_drill_*` 工具的对话内卡片（keyed `tool.call.toolview`）。
 *
 * 为什么必须自己渲染输出：官方源码写明 **keyed 命中会"替换"通用行**
 * （`packages/client/ui-tool/src/client/tool/models/tool-call-model.ts:29-36`：
 * "ui-cordis registers a keyed `tool.call.toolview` entry for it, and a keyed hit REPLACES the generic row"）
 * ⇒ 注册了 key 却不画内容，用户就看不到工具结果了。
 *
 * 数据面（本机 0.1.1-rc.1 的契约，逐字核过）：
 * `ToolCallOwnerProps = { callId, toolName, block, cwd?, home?, openFile, inspect? }`
 * （`packages/client/ui-tool/src/client/contract/slots.ts:29-44`）；
 * `block` 是"冻结的运行中调用**或**已落定结果"：`'kind' in block` 判落定，
 * 落定节点带 `content: readonly ContentBlock[]` / `isError` / `error`
 * （`packages/client/runtime/lib/types/client/sessions/conversation.d.ts:165-185`）。
 *
 * @module @math-drill/dsh-plugin/client/card
 */

import { createElement as h } from 'react'

/** 卡片能拿到的 props 子集（只声明我们真正读的字段，避免猜契约）。 */
export interface MathDrillCardProps {
  /** Wire 工具名（keyed 分发值）。 */
  toolName?: string
  /** 运行中调用或已落定结果。 */
  block?: {
    kind?: string
    content?: readonly { type?: string, text?: string }[]
    isError?: boolean
    error?: { name?: string, code?: string }
  }
  /** 文案座位（`locale: NS` 的产物）。 */
  t?: (key: string) => string
}

/** 卡片一次最多显示的行数（对话流要能扫得动；超出折叠成一行提示）。 */
export const CARD_MAX_LINES = 12

const BOX_STYLE = {
  border: '0.5px solid var(--dsw-alias-border-l2)',
  borderRadius: '8px',
  padding: '6px 10px',
  margin: '4px 0',
  fontSize: '12px',
  lineHeight: '1.6',
} as const

const HEAD_STYLE = {
  display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px', opacity: 0.9,
} as const

const BODY_STYLE = { whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0 } as const

/** 卡片状态：运行中 / 成功 / 出错（官方 `ToolRowState` 的口径，这里只取我们要的三档）。 */
export function cardState(block: MathDrillCardProps['block']): 'running' | 'ok' | 'error' {
  if (block === undefined || block.kind === undefined) return 'running'
  return block.isError === true ? 'error' : 'ok'
}

/** 文本内容行：取 `content` 里的 text 块（非 text 块一律忽略）。 */
export function cardLines(block: MathDrillCardProps['block']): string[] {
  const blocks = block?.content ?? []
  return blocks
    .filter((entry) => entry?.type === 'text' && typeof entry.text === 'string')
    .flatMap((entry) => String(entry.text).split('\n'))
}

/**
 * 渲染一张 `math_drill_*` 卡片。
 *
 * @param props - 槽位渲染器组合出来的 props（见文件头的数据面说明）。
 * @returns React 元素。
 */
export function MathDrillCard(props: MathDrillCardProps) {
  const translate = (key: string, fallback: string): string =>
    typeof props.t === 'function' ? props.t(key) : fallback
  const state = cardState(props.block)
  const lines = cardLines(props.block)
  const shown = lines.slice(0, CARD_MAX_LINES)
  const hidden = lines.length - shown.length

  const title = props.toolName === 'math_drill_today'
    ? translate('card.today', '考研数学 · 今日题单')
    : translate('card.progress', '考研数学 · 进度')
  const mark = state === 'running' ? '⏳' : state === 'error' ? '⚠️' : '✓'
  const body = shown.length > 0
    ? shown.join('\n')
    : state === 'running'
      ? translate('card.running', '读取中…')
      : props.block?.error?.code ?? translate('card.empty', '（没有内容）')

  return h('div', { style: BOX_STYLE, 'data-math-drill': 'card' },
    h('div', { style: HEAD_STYLE },
      h('span', null, mark),
      h('span', null, title),
    ),
    h('pre', { style: BODY_STYLE }, body),
    hidden > 0
      ? h('div', { style: { opacity: 0.7 } },
          translate('card.truncated', `…还有 ${hidden} 行（展开详情可看全）`))
      : null,
  )
}
