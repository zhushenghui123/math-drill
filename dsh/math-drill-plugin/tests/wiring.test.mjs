/**
 * 接线测试：**真的调用 `apply()`**，断言它注册了什么、以及工具跑起来会回什么。
 *
 * 为什么这样测而不是"启动一次看日志"：日志级别一变就看不见，属于靠不住的证据。
 * 这里用一个假 cordis ctx（`tools.register` 收单、`effect` 记 disposer）——
 * 于是"插件到底注册了几个工具、凭据没配时是什么行为、配了之后输出什么"全都能断言。
 *
 * 前置：`node tools/link-dsh-deps.mjs`（把 `@deepseek-ai/*` 链到本机 DSH；
 * 没链的话本文件会因为解析不到 `@deepseek-ai/dsh-tools` 而失败 —— 这正是它的用处之一）。
 */

import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { apply, Config, inject, name } from '../src/index.js'
import { STATE_PATH, STATE_SCHEMA_VERSION } from '../src/shared/contract.js'
// 真实契约的锚：桩（stub）不自己发明方法名，而是**照着真服务的原型**建。
// 起因（2026-09-19 实拍）：我把 `ctx.webServer.register` 写成 `registerRoute`，
// 而桩用了同一个错名字 ⇒ 测试全绿、**真实 profile 启动失败**。
import WebServer from '@deepseek-ai/dsh-host-webserver'
import ToolRuntime from '@deepseek-ai/dsh-tools'

const CREDENTIAL = 'wiring-test-credential-0123456789abcdef'
const QUESTION = {
  id: 'linalg.det.3x3.a', kid: 'c1n1', type: 'blank', difficulty: 2,
  stem: '计算三阶行列式。', options: null,
  answer: '-3', analysis: '按第一行展开得 -3。',
}

/**
 * 照真实服务原型建的桩：访问一个**真服务上没有的方法**时立刻抛错。
 *
 * @param {object} real - 真实服务类（如 `WebServer`）。
 * @param {string} label - 报错里用的服务名。
 * @param {Array<[string, unknown[]]>} calls - 落账本。
 */
function serviceStub(real, label, calls) {
  return new Proxy({}, {
    get(_target, property) {
      if (typeof property !== 'string') return undefined
      const realMethod = real.prototype?.[property]
      if (typeof realMethod !== 'function') {
        throw new TypeError(
          `宿主服务 ${label} 没有 ${property}() —— 契约漂移（真源：该包导出的服务类原型）`,
        )
      }
      return (...args) => {
        calls.push([property, args])
        return () => {}
      }
    },
  })
}

/** 假 cordis ctx：服务桩都锚在真实原型上，只实现本插件真正用到的那几件事。 */
function fakeContext() {
  const effects = []
  const logs = []
  const toolCalls = []
  const serverCalls = []
  return {
    effects,
    logs,
    toolCalls,
    serverCalls,
    tools: serviceStub(ToolRuntime, 'tools', toolCalls),
    webServer: serviceStub(WebServer, 'webServer', serverCalls),
    effect(factory, label) {
      effects.push(label)
      const dispose = factory()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    logger: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
  }
}

/** 桩上记到的 `register` 调用载荷（工具或路由）。 */
function registeredVia(stubCalls, method = 'register') {
  return stubCalls.filter(([name]) => name === method).map(([, args]) => args[0])
}

let upstream
let credDir

/** 假响应对象：只实现路由 handler 用到的那三个方法（够断言状态码与 body）。 */
function fakeResponse() {
  return {
    status: undefined,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    writeHead(status) {
      this.status = status
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk)
    },
  }
}

before(async () => {
  upstream = await new Promise((resolve) => {
    const server = createServer((req, res) => {
      if ((req.headers.authorization ?? '') !== `Bearer ${CREDENTIAL}`) {
        res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(req.url === '/api/daily'
        ? { server_version: 3, daily: { date: '2026-09-19' }, questions: [QUESTION] }
        : { server_version: 3, data: { settings: { examTrack: 'math1' }, daily: null, checkins: {}, cards: {}, notes: {} } }))
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }))
  })
  credDir = mkdtempSync(join(tmpdir(), 'math-drill-wiring-'))
})
after(() => {
  upstream?.server.close()
  if (credDir) rmSync(credDir, { recursive: true, force: true })
})

describe('插件接线（ADR-015 决策 1/5）', () => {
  it('契约桩**自检**：真服务原型上没有的方法名会立刻抛（防"桩跟着错误一起错"）', () => {
    const stub = serviceStub(WebServer, 'webServer', [])
    // 2026-09-19 的实拍错误：这个拼写不存在的名字曾让测试全绿、真机启动失败
    assert.throws(() => stub.registerRoute, /契约漂移/)
    assert.equal(typeof stub.register, 'function', '真名是 register')
    const tools = serviceStub(ToolRuntime, 'tools', [])
    assert.equal(typeof tools.register, 'function')
    assert.throws(() => tools.define, /契约漂移/)
  })

  it('导出 cordis 需要的 name / inject / Config / apply', () => {
    assert.equal(name, 'math-drill-dsh')
    assert.deepEqual(inject, ['tools', 'webServer'])
    assert.ok(Config !== undefined, '要有 Config schema（补丁层靠它校验 config）')
    assert.equal(typeof apply, 'function')
  })

  it('apply() 注册两个只读工具 + 一条只读摘要路由，并各挂一个 disposer', async () => {
    const ctx = fakeContext()
    await apply(ctx, { baseUrl: upstream.baseUrl, credentialPath: join(credDir, 'missing') })
    assert.deepEqual(registeredVia(ctx.toolCalls).map((tool) => tool.name), ['math_drill_progress', 'math_drill_today'])
    assert.equal(ctx.effects.length, 3, '每个工具 + 路由都要有自己的 effect（卸载即注销）')
    assert.deepEqual(registeredVia(ctx.serverCalls).map((route) => [route.kind, route.path]), [['exact', STATE_PATH]])
    for (const tool of registeredVia(ctx.toolCalls)) {
      assert.ok(tool.description.length > 20, '工具描述要够长，模型才知道何时用')
      assert.equal(typeof tool.execute, 'function')
      assert.ok(tool.parameters !== undefined && tool.output?.schema !== undefined)
    }
  })

  it('摘要路由：GET 回 ok:true 的文本；非 GET 回 405（只读的结构性保证）', async () => {
    const path = join(credDir, 'credential-route')
    writeFileSync(path, `${CREDENTIAL}\n`, { mode: 0o600 })
    chmodSync(path, 0o600)
    const ctx = fakeContext()
    await apply(ctx, { baseUrl: upstream.baseUrl, credentialPath: path })
    const route = registeredVia(ctx.serverCalls)[0]

    const okResponse = fakeResponse()
    await route.handler({ method: 'GET' }, okResponse)
    assert.equal(okResponse.status, 200)
    const payload = JSON.parse(okResponse.body)
    assert.equal(payload.ok, true)
    assert.equal(payload.schemaVersion, STATE_SCHEMA_VERSION, '响应必须带契约版本（评审 §B4 正解 (a)）')
    assert.match(payload.text, /三阶行列式/)
    assert.equal(payload.text.includes(QUESTION.answer), false, '答案不得进浏览器')
    assert.equal(payload.text.includes(CREDENTIAL), false, '凭据不得进浏览器')

    const denied = fakeResponse()
    await route.handler({ method: 'POST' }, denied)
    assert.equal(denied.status, 405)
    assert.equal(JSON.parse(denied.body).ok, false)
  })

  it('摘要路由：凭据没配时回 ok:false + 可操作消息（面板直接显示它）', async () => {
    const ctx = fakeContext()
    await apply(ctx, { baseUrl: upstream.baseUrl, credentialPath: join(credDir, 'missing-route') })
    const response = fakeResponse()
    await registeredVia(ctx.serverCalls)[0].handler({ method: 'GET' }, response)
    assert.equal(response.status, 200)
    const payload = JSON.parse(response.body)
    assert.equal(payload.ok, false)
    assert.equal(payload.schemaVersion, STATE_SCHEMA_VERSION)
    assert.match(payload.error, /凭据/)
  })

  it('没配凭据：插件照常加载，工具报可操作的错（而不是崩宿主）', async () => {
    const ctx = fakeContext()
    await apply(ctx, { baseUrl: upstream.baseUrl, credentialPath: join(credDir, 'missing') })
    const progress = registeredVia(ctx.toolCalls).find((tool) => tool.name === 'math_drill_progress')
    const error = await progress.execute({}, {}).then(() => null, (thrown) => thrown)
    assert.ok(error instanceof Error, '应抛出错误')
    assert.match(error.message, /凭据/)
    assert.equal(error.message.includes(CREDENTIAL), false)
  })

  it('配好凭据后：两个工具都端到端跑通，且答案不进输出', async () => {
    const path = join(credDir, 'credential')
    writeFileSync(path, `${CREDENTIAL}\n`, { mode: 0o600 })
    chmodSync(path, 0o600)
    const ctx = fakeContext()
    await apply(ctx, { baseUrl: upstream.baseUrl, credentialPath: path })

    const progress = await registeredVia(ctx.toolCalls)[0].execute({}, {})
    assert.match(progress.text, /数学一/)
    assert.match(progress.text, /server_version=3/)
    assert.equal(progress.text.includes(CREDENTIAL), false, '凭据绝不能进输出')

    const today = await registeredVia(ctx.toolCalls)[1].execute({}, {})
    assert.match(today.text, /三阶行列式/)
    assert.equal(today.text.includes(QUESTION.answer), false, '答案不得进上下文（红线）')
    assert.equal(today.text.includes('按第一行展开'), false, '解析不得进上下文（红线）')
  })

  it('权限 0644 的凭据文件：拒绝读取（凭据纪律）', async () => {
    const path = join(credDir, 'wide-open')
    writeFileSync(path, `${CREDENTIAL}\n`, { mode: 0o644 })
    chmodSync(path, 0o644)
    const ctx = fakeContext()
    await apply(ctx, { baseUrl: upstream.baseUrl, credentialPath: path })
    const error = await registeredVia(ctx.toolCalls)[0].execute({}, {}).then(() => null, (thrown) => thrown)
    assert.match(error.message, /权限过宽/)
    assert.equal(error.message.includes(CREDENTIAL), false)
  })
})
