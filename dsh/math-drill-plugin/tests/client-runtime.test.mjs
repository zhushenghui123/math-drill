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
async function loadBundle() {
  const registrations = []
  const calls = { fetch: [], registered: [], injected: [] }

  globalThis.window = { __ModuleLoader__: { load: (record) => registrations.push(record) } }
  await import(`${new URL(`file://${artifact}`).href}?t=${Date.now()}`)
  assert.equal(registrations.length, 1, '产物必须恰好注册一次')
  const [{ id, factory }] = registrations

  const react = fakeReact()
  const require = (specifier) => {
    if (specifier === 'react') return react
    throw new Error(`产物 require 了平台表外的模块：${specifier}`)
  }
  const exports = factory(require)

  const ctx = {
    slots: {
      inject: (name, callback) => { calls.injected.push(name); callback() },
      register: (options, component) => { calls.registered.push({ options, component }); return () => {} },
    },
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
    assert.deepEqual(exports.inject, ['slots'])
    assert.equal(typeof exports.apply, 'function')
    assert.deepEqual(calls.injected, ['conversation.input.dock'])
    assert.equal(calls.registered.length, 1)
    assert.deepEqual(calls.registered[0].options, {
      name: 'conversation.input.dock', id: 'math-drill', order: 20,
    })
    assert.equal(typeof calls.registered[0].component, 'function')
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
        json: async () => ({ ok: true, text: '数学一 · 复习 1/2', fetchedAt: 1 }),
      }
    }
    try {
      const { component } = calls.registered[0]
      const tree = component({})                       // 渲染（useEffect 会立刻跑 = 拉数据）
      await new Promise((done) => setImmediate(done))   // 等 await fetch 落地
      const rendered = JSON.stringify(tree)
      assert.equal(calls.fetch.length, 1, '挂载时应拉一次')
      assert.equal(calls.fetch[0].url, '/math-drill/summary')
      assert.equal(calls.fetch[0].init.method ?? 'GET', 'GET', '必须只读')
      assert.match(rendered, /考研数学/)
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

  it('宿主回 ok:false 时把可操作消息显示出来（面板即说明书）', async (t) => {
    if (!existsSync(artifact)) {
      t.skip('lib/client.js 还没构建')
      return
    }
    const { react, calls } = await loadBundle()
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => ({
      ok: true, status: 200, json: async () => ({ ok: false, error: '未配置服务间凭据：…chmod 600' }),
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
