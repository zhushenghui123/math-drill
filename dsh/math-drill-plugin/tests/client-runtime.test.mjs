/**
 * **产物运行时**测试：按 loader 契约在 Node 里真的执行 `lib/client.js`。
 *
 * 为什么需要它（补一个真实的验证空洞）：`tests/client-bundle.test.mjs` 只查产物**形状**（外壳/require 表/CJS），
 * 而"这段代码跑起来会不会注册、会不会渲染"在 2026-09-20 之前**从没被执行过** ——
 * 浏览器那侧只能靠人开 DSH 看，而我起 app + 浏览器工具当时都不可用。
 *
 * 这里用一个**最小 loader 替身**：`window.__ModuleLoader__.load` 收下 `{id, factory}`，
 * 再用假 `require('react')` + 假 `ctx.slots` 真正跑 `factory()` → `apply()` → **渲染组件**，
 * 并断言它发出了对的请求、渲染出了该有的元素、且**不含答案/凭据**。
 *
 * ⚠️ 边界（别把它当等价替代）：这**不能**证明宿主真的把它挂进了 DOM ——
 * `conversation.input.dock` 是 **session 作用域**，冷启动落地页没有 composer，
 * 真实渲染仍要在 DSH 里开一个会话才能看见。本测试证明的是"产物本身没坏"。
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifact = join(packageRoot, 'lib', 'client.js')
const BUNDLE_ID = '@math-drill/dsh-plugin'
const { STATE_PATH, STATE_SCHEMA_VERSION } = await import('../src/shared/contract.js')

/** 每次 import 产物用的唯一序号（见 loadBundle 里的注释：Date.now() 会同毫秒撞车）。 */
let bundleImportSeq = 0

/** 极简 React 替身：够跑我们的组件（createElement + 三个 hook）。 */
function fakeReact() {
  const state = { value: undefined, setters: [] }
  return {
    state,
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      if (state.value === undefined) state.value = initial
      const setter = (next) => {
        state.value = typeof next === 'function' ? next(state.value) : next
        state.setters.push(state.value)
      }
      return [state.value, setter]
    },
    useCallback: (fn) => fn,
    useEffect: (fn) => { fn() },
  }
}

/** 把产物当浏览器脚本执行：抓注册、materialize、跑 apply。 */
async function loadBundle(options = {}) {
  const registrations = []
  const calls = { fetch: [], registered: [], injected: [], dictionaries: [], effects: [] }

  globalThis.window = { __ModuleLoader__: { load: (record) => registrations.push(record) } }
  // 缓存击穿必须**唯一**：早先用 Date.now() 时，同一毫秒内的两次 import 会命中缓存
  // ⇒ 第二次拿到缓存、注册 0 次（测试自己抓到的 flake）。用自增计数替代。
  bundleImportSeq += 1
  await import(`${new URL(`file://${artifact}`).href}?t=${bundleImportSeq}`)
  assert.equal(registrations.length, 1, '产物必须恰好注册一次')
  const [{ id, factory }] = registrations

  const react = fakeReact()
  const require = (specifier) => {
    if (specifier === 'react') return react
    throw new Error(`产物 require 了平台表外的模块：${specifier}`)
  }
  const exports = factory(require)

  const localeService = {
    register: (namespace, dictionaries) => { calls.dictionaries.push({ namespace, dictionaries }); return () => {} },
  }
  const ctx = {
    slots: {
      inject: (name, callback) => { calls.injected.push(name); callback() },
      register: (options, component) => { calls.registered.push({ options, component }); return () => {} },
    },
    // locale 是**可选**服务：按官方取向用 ctx.get 取（不声明 inject ⇒ 缺失也不会挂起插件）
    get: (name) => (name === 'locale' ? (options.withLocale === false ? undefined : localeService) : undefined),
    effect: (factory) => { calls.effects.push(factory); return factory(); },
  }
  exports.apply(ctx)
  return { id, exports, react, calls }
}

describe('产物运行时（按 loader 契约真执行）', () => {
  it('注册 id 正确、导出 inject/apply、往追加型槽位注册一条', async (t) => {
    if (!existsSync(artifact)) {
      t.skip('lib/client.js 还没构建（先跑 node tools/build-client.mjs）')
      return
    }
    const { id, exports, calls } = await loadBundle()
    assert.equal(id, BUNDLE_ID)
    assert.deepEqual(exports.inject, ['slots'], 'locale 是可选服务，不该进 inject')
    assert.equal(typeof exports.apply, 'function')
    assert.equal(calls.effects.length, 1, '字典注册必须包在 effect 里（可卸载）')
    assert.equal(calls.dictionaries.length, 1, '要注册一份文案字典')
    assert.equal(calls.dictionaries[0].namespace, 'math-drill')
    // 一条状态条 + 两条工具卡片（keyed tool.call.toolview）
    assert.deepEqual(calls.injected, [
      'conversation.input.dock', 'tool.call.toolview', 'tool.call.toolview',
    ])
    assert.equal(calls.registered.length, 3)
    assert.deepEqual(calls.registered[0].options, {
      name: 'conversation.input.dock', id: 'math-drill', order: 20, locale: 'math-drill',
    }, '有 locale 服务时应声明命名空间')
    assert.deepEqual(
      calls.registered.slice(1).map((entry) => entry.options),
      [
        { name: 'tool.call.toolview', key: 'math_drill_progress', locale: 'math-drill' },
        { name: 'tool.call.toolview', key: 'math_drill_today', locale: 'math-drill' },
      ],
      '两张卡片的 key 必须等于 wire 工具名',
    )
    for (const entry of calls.registered) assert.equal(typeof entry.component, 'function')
  })

  it('文案字典：zh/en 键集合必须相等，且键都带命名空间语义（有测试盯着）', async (t) => {
    if (!existsSync(artifact)) {
      t.skip('lib/client.js 还没构建')
      return
    }
    const { exports } = await loadBundle()
    const { zh, en } = exports.dictionaries
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(),
      'zh/en 键必须一一对应（官方要求：键对齐）')
    assert.ok(Object.keys(zh).length >= 5, '至少 5 条文案')
  })

  it('组件会去拉宿主摘要路由，并把结果渲染出来（文案与按钮都在）', async (t) => {
    if (!existsSync(artifact)) {
      t.skip('lib/client.js 还没构建')
      return
    }
    const { react, calls } = await loadBundle()
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      calls.fetch.push({ url, init })
      return {
        ok: true,
        status: 200,
        json: async () => ({ schemaVersion: STATE_SCHEMA_VERSION, ok: true, text: '数学一 · 复习 1/2', fetchedAt: 1 }),
      }
    }
    try {
      const { component } = calls.registered[0]
      const tree = component({})                       // 渲染（useEffect 会立刻跑 = 拉数据）
      await new Promise((done) => setImmediate(done))   // 等 await fetch 落地
      const rendered = JSON.stringify(tree)
      assert.equal(calls.fetch.length, 1, '挂载时应拉一次')
      assert.equal(calls.fetch[0].url, STATE_PATH)
      assert.equal(calls.fetch[0].init.method ?? 'GET', 'GET', '必须只读')
      assert.match(rendered, /考研数学/)   // 回退 zh 字典（没有 t 座位时）
      assert.match(rendered, /刷新/)
      // 两次：挂载先置 loading，拿到响应再置 ready（写断言时我自己就先写错过）
      assert.equal(react.state.setters.length, 2, '应先 loading 再写回结果')
      assert.deepEqual(react.state.setters[0], { kind: 'loading' })
      assert.match(JSON.stringify(react.state.value), /复习 1\/2/)
      // 第二次渲染（状态已就绪）应把文本显示出来
      const after = JSON.stringify(component({}))
      assert.match(after, /复习 1\/2/)
    } finally {
      globalThis.fetch = originalFetch
      delete globalThis.window
    }
  })

  it('有 t 座位时用宿主语言（字典不再被绕过）', async (t) => {
    if (!existsSync(artifact)) {
      t.skip('lib/client.js 还没构建')
      return
    }
    const { react, calls } = await loadBundle()
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => ({
      ok: true, status: 200, json: async () => ({ schemaVersion: STATE_SCHEMA_VERSION, ok: true, text: 'ok', fetchedAt: 1 }),
    })
    try {
      const t = (key) => `EN:${key}`
      const rendered = JSON.stringify(calls.registered[0].component({ t }))
      assert.match(rendered, /EN:label/)
      assert.match(rendered, /EN:action\.refresh/)
      assert.equal(react.state.value.kind, 'loading')
    } finally {
      globalThis.fetch = originalFetch
      delete globalThis.window
    }
  })

  it('宿主回了不认识的 schema 版本 ⇒ 明确报错，而不是当成新形状硬读', async (t) => {
    if (!existsSync(artifact)) {
      t.skip('lib/client.js 还没构建')
      return
    }
    const { react, calls } = await loadBundle()
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => ({
      ok: true, status: 200, json: async () => ({ schemaVersion: 999, ok: true, text: '未来形状' }),
    })
    try {
      calls.registered[0].component({})
      await new Promise((done) => setImmediate(done))
      assert.match(JSON.stringify(react.state.value), /未知版本/)
    } finally {
      globalThis.fetch = originalFetch
      delete globalThis.window
    }
  })

  it('宿主回 ok:false 时把可操作消息显示出来（面板即说明书）', async (t) => {
    if (!existsSync(artifact)) {
      t.skip('lib/client.js 还没构建')
      return
    }
    const { react, calls } = await loadBundle()
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ schemaVersion: STATE_SCHEMA_VERSION, ok: false, error: '未配置服务间凭据：…chmod 600' }),
    })
    try {
      calls.registered[0].component({})
      await new Promise((done) => setImmediate(done))
      assert.match(JSON.stringify(react.state.value), /未配置服务间凭据/)
    } finally {
      globalThis.fetch = originalFetch
      delete globalThis.window
    }
  })
})

describe('locale 缺失时的行为（定点复查清单项：不能静默不激活）', () => {
  it('宿主没有 locale 服务 ⇒ 插件照常激活、仍注册槽位、且**不**声明命名空间', async (t) => {
    if (!existsSync(artifact)) {
      t.skip('lib/client.js 还没构建')
      return
    }
    const { calls } = await loadBundle({ withLocale: false })
    assert.equal(calls.dictionaries.length, 0, '没有服务就不该注册字典')
    assert.equal(calls.registered.length, 3, '槽位与卡片注册必须照常发生（不能静默不激活）')
    for (const entry of calls.registered) {
      assert.equal('locale' in entry.options, false, '没注册字典就不该声明命名空间')
    }
    // 渲染仍要能出字（走回退字典，同一份 DICTS）
    const rendered = JSON.stringify(calls.registered[0].component({}))
    assert.match(rendered, /考研数学/)
  })
})

describe('工具卡片（keyed tool.call.toolview）', () => {
  it('落定结果把工具输出画出来（keyed 命中会替换通用行 ⇒ 必须自己画）', async (t) => {
    if (!existsSync(artifact)) {
      t.skip('lib/client.js 还没构建')
      return
    }
    const { calls } = await loadBundle()
    const card = calls.registered[1]           // math_drill_progress 的卡片
    const rendered = JSON.stringify(card.component({
      toolName: 'math_drill_progress',
      block: { kind: 'tool-result', content: [{ type: 'text', text: '轨道：数学一\n复习 1/2' }], isError: false },
    }))
    assert.match(rendered, /考研数学 · 进度/)
    assert.match(rendered, /复习 1\/2/)
    assert.match(rendered, /✓/)
  })

  it('运行中与出错两档各有明确表现，不显示空白卡片', async (t) => {
    if (!existsSync(artifact)) {
      t.skip('lib/client.js 还没构建')
      return
    }
    const { calls } = await loadBundle()
    const card = calls.registered[2]           // math_drill_today 的卡片
    const running = JSON.stringify(card.component({ toolName: 'math_drill_today', block: {} }))
    assert.match(running, /⏳/)
    assert.match(running, /读取中/)
    const failed = JSON.stringify(card.component({
      toolName: 'math_drill_today',
      block: { kind: 'tool-result', content: [], isError: true, error: { code: 'unavailable' } },
    }))
    assert.match(failed, /⚠️/)
    assert.match(failed, /unavailable/, '出错时至少把错误码显示出来')
  })
})
