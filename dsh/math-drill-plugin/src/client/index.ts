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
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement as h, useCallback, useEffect, useState } from 'react'
// 相对 import ⇒ 被 tsdown 内联进产物（不是 require），与宿主半边共用同一份契约（评审 Z1 的正解）
import { isStateResponse, STATE_PATH } from '../shared/contract.js'
import { MathDrillCard } from './MathDrillCard.js'

/**
 * 本插件需要的浏览器服务：**只有槽位**（UI 是硬依赖：没槽位就没面板）。
 *
 * 为什么 `locale` **不写成 inject**（2026-09-20 定点复查的清单项）：
 * 硬 `inject` 的语义是"服务不出现就一直等" ⇒ 若某个宿主没有 locale 服务，插件会**静默不激活**
 * （面板整块不见、也不报错），比"没座位就用回退字典"糟得多。
 * 官方 Skill 的取向也正是"默认 `ctx.get(name)` + 自检缺失，只有真硬依赖才 inject"
 * （`参考-DSH官方文档-20260920/官方Skill-cordis-plugin-development.md` 的 "Access Services" 段）。
 * ⇒ locale 走 `ctx.get('locale')`，缺失时用本地回退字典（同一份 `DICTS`，不是第二份真值）。
 */
export const inject = ['slots']

/** 文案命名空间（与 `slots.register` 的 `locale` 选项同值）。 */
const NS = 'math-drill'

/**
 * 文案字典 —— **唯一真源**（`src/client/index.ts` 里不再出现任何产品可见字符串字面量）。
 *
 * 依据：`参考-DSH官方文档-20260920/docs/client-AGENTS.md:115`（所有产品可见文案必须进 typed locale 字典）；
 * 官方写法见 `packages/extensions/ui-cordis/src/client/index.ts:41`。
 * zh/en **键集合必须相等**（有测试盯着）。
 */
const DICTS = {
  zh: {
    'label': '考研数学',
    'action.refresh': '刷新',
    'state.loading': '读取中…',
    'error.fetch': '取不到考研数学状态',
    'error.unknownShape': '宿主返回了未知版本的状态（插件与宿主版本不匹配？）',
    'card.today': '考研数学 · 今日题单',
    'card.progress': '考研数学 · 进度',
    'card.running': '读取中…',
    'card.empty': '（没有内容）',
    'card.truncated': '…还有更多行（展开详情可看全）',
  },
  en: {
    'label': 'Math Drill',
    'action.refresh': 'Refresh',
    'state.loading': 'Loading…',
    'error.fetch': 'Cannot reach the math-drill status route',
    'error.unknownShape': 'The host returned an unknown status shape (plugin/host version mismatch?)',
    'card.today': 'Math Drill · today',
    'card.progress': 'Math Drill · progress',
    'card.running': 'Loading…',
    'card.empty': '(no content)',
    'card.truncated': '…more lines (open details for the full output)',
  },
} as const

/** 注册卡片的工具名（keyed 分发值 = wire 工具名；改这里必须同步 `src/tools.js` 的工具名）。 */
export const TOOL_CARD_KEYS = ['math_drill_progress', 'math_drill_today'] as const

/** 字典键类型（zh 为基准；en 必须键对齐）。 */
type MessageKey = keyof (typeof DICTS)['zh']

/**
 * 文案取词：优先用槽位渲染器绑进来的 `t`（`locale: NS` 的产物），没有则回退 zh 字典。
 *
 * 回退**不是第二份真值**：它读的就是上面那份 `DICTS`。这样即使某个宿主没给座位，
 * 面板也只会显示中文而不是键名。
 */
function translate(props: unknown, key: MessageKey): string {
  const seat = (props as { t?: (key: string) => string } | undefined)?.t
  if (typeof seat === 'function') return seat(key)
  return DICTS.zh[key]
}

/** 槽位注册的 id（同一槽位里与官方/其他插件的条目共存靠它区分）。 */
const SLOT_ID = 'math-drill'

/** 状态响应的形状（真源 = `src/shared/contract.js` 的版本常量）。 */
type SummaryResponse =
  | { schemaVersion: number; ok: true; text: string; fetchedAt: number }
  | { schemaVersion: number; ok: false; error: string }

const BOX_STYLE = {
  display: 'flex', alignItems: 'flex-start', gap: '10px', flexWrap: 'wrap',
  padding: '6px 12px', margin: '0 0 6px', borderRadius: '10px',
  background: 'var(--dsw-alias-bg-layer-1)',
  // 只引语义 token，不写颜色字面量（web-styling.zh.md:17）；这是**扁平行**不是浮层，
  // 故按 :25 用中性发丝边框，而上游 :24 的 --dsw-elevation-* 在本机 0.1.1-rc.1 **并不存在**
  // （2026-09-20 评审实测：全树零命中）⇒ 不用投影。
  border: '0.5px solid var(--dsw-alias-border-l2)',
  fontSize: '12px', lineHeight: '1.5', opacity: 0.92,
} as const

const LABEL_STYLE = { fontWeight: 600, whiteSpace: 'nowrap', paddingTop: '1px' } as const
/** 正文用 markdown 渲染（和卡片同一件官方渲染件）⇒ 行距/列表/公式都有正确排版。 */
const TEXT_STYLE = { flex: '1 1 260px', minWidth: 0 } as const
const BUTTON_STYLE = {
  border: '0.5px solid var(--dsw-alias-border-l2)', background: 'transparent',
  color: 'var(--dsw-alias-brand-primary)',
  borderRadius: '6px', padding: '1px 8px', fontSize: '12px', cursor: 'pointer', opacity: 0.8,
} as const

/**
 * 状态条组件：挂载时拉一次摘要，点「刷新」再拉。
 *
 * 失败**不抛**：把宿主回的可操作消息原样显示（没配凭据就是提示怎么配），
 * 这样面板本身就是"怎么把它配起来"的说明书。
 */
function MathDrillDock(props: unknown) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'ready'; text: string } | { kind: 'failed'; message: string }
  >({ kind: 'loading' })

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' })
    try {
      const response = await fetch(STATE_PATH, { headers: { Accept: 'application/json' } })
      const payload = await response.json() as SummaryResponse
      if (!isStateResponse(payload)) {
        setState({ kind: 'failed', message: translate(props, 'error.unknownShape') })
        return
      }
      setState(payload.ok
        ? { kind: 'ready', text: payload.text }
        : { kind: 'failed', message: payload.error })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setState({ kind: 'failed', message: `${translate(props, 'error.fetch')}：${detail}` })
    }
  }, [props])

  useEffect(() => { void load() }, [load])

  const body = state.kind === 'loading'
    ? translate(props, 'state.loading')
    : state.kind === 'ready' ? state.text : `⚠️ ${state.message}`

  return h('div', { style: BOX_STYLE, 'data-math-drill': 'dock' },
    h('span', { style: LABEL_STYLE }, translate(props, 'label')),
    h('div', { style: TEXT_STYLE },
      state.kind === 'ready'
        ? h(MarkdownText, { text: body })
        : h('span', null, body)),
    h('button', { type: 'button', style: BUTTON_STYLE, onClick: () => { void load() } },
      translate(props, 'action.refresh')),
  )
}

/**
 * 挂载客户端半边：往 `conversation.input.dock` 追加一条。
 *
 * @param ctx - DSH 客户端上下文（cordis）。
 */
export function apply(ctx: {
  slots: { inject: (name: string, factory: () => unknown) => void; register: (options: Record<string, unknown>, component: unknown) => unknown }
  /** 可选服务：用 `ctx.get('locale')` 取，不声明 inject（见 `inject` 的注释）。 */
  get?: (name: string) => unknown
  effect?: (factory: () => unknown, label?: string) => unknown
}): void {
  // locale 是**可选**服务：缺失时面板用回退字典（同一份 DICTS），而不是把插件挂起。
  // 为什么只走 `ctx.get`、不写 `ctx.locale` 兜底（2026-09-20 第二轮定点复查清单 3）：
  // ① `ctx.get` 恒为函数（context.d.ts:28-29）⇒ 那个兜底分支**永不执行**，是死码；
  // ② 若它真被执行，正是 Guard 会拒的写法 —— 未声明 inject 就按服务名访问会报
  //    `service "x" is not declared`（官方 Skill "Common failure checks" 首行）。
  // ⇒ 删掉兜底，只留 `ctx.get`。
  const locale = ctx.get?.('locale') as
    | { register: (namespace: string, dictionaries: Record<string, unknown>) => unknown }
    | undefined
  if (locale !== undefined) {
    // 字典注册包在 effect 里 ⇒ 卸载/热替换时自动撤销（官方同款：ui-cordis/src/client/index.ts:41）
    const registerDicts = () => locale.register(NS, DICTS)
    if (typeof ctx.effect === 'function') ctx.effect(registerDicts, `${NS}: dictionaries`)
    else registerDicts()
  }

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: SLOT_ID,
    order: 20,
    // 只有在真的注册过字典时才声明命名空间：否则渲染器会去找一个不存在的命名空间
    ...(locale === undefined ? {} : { locale: NS }),
  }, MathDrillDock))

  // 工具卡片：keyed `tool.call.toolview`，key = wire 工具名。
  // ⚠️ keyed 命中**会替换**通用行 ⇒ 卡片必须自己把输出画出来（见 MathDrillCard 的文件头注释）。
  for (const key of TOOL_CARD_KEYS) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview',
      key,
      ...(locale === undefined ? {} : { locale: NS }),
    }, MathDrillCard))
  }
}

/** 测试用导出：字典（键对齐与文案断言都在测试里）。 */
export const dictionaries = DICTS

/** 测试用导出：文案命名空间。 */
export const localeNamespace = NS
