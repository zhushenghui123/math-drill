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

import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
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

const BOX_STYLE = {
  border: '0.5px solid var(--dsw-alias-border-l2)',
  borderRadius: '8px',
  padding: '8px 12px',
  margin: '6px 0',
  fontSize: '12px',
} as const

const HEAD_STYLE = {
  display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px',
  fontWeight: 600, letterSpacing: '0.01em',
} as const

const MARK_STYLE = { opacity: 0.85 } as const

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
  // 正文**不截断**：题面里有 LaTeX，按行截会截断公式（渲染出半个矩阵）
  const body = cardLines(props.block).join('\n')

  const title = props.toolName === 'math_drill_today'
    ? translate('card.today', '考研数学 · 今日题单')
    : translate('card.progress', '考研数学 · 进度')
  const mark = state === 'running' ? '⏳' : state === 'error' ? '⚠️' : '✓'
  const fallback = state === 'running'
    ? translate('card.running', '读取中…')
    : props.block?.error?.code ?? translate('card.empty', '（没有内容）')

  return h('div', { style: BOX_STYLE, 'data-math-drill': 'card' },
    h('div', { style: HEAD_STYLE },
      h('span', { style: MARK_STYLE }, mark),
      h('span', null, title),
    ),
    // markdown + KaTeX：题面里的 \begin{vmatrix}… 由官方渲染件画出来，不再是裸 LaTeX
    body === '' ? h('div', { style: { opacity: 0.75 } }, fallback) : h(MarkdownText, { text: body }),
  )
}
