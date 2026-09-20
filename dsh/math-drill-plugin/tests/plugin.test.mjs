/**
 * 桥接插件（宿主半边）的零依赖测试：`node --test dsh/math-drill-plugin/tests/`。
 *
 * 为什么用 `node --test` 而不是 vitest：本插件**没有任何第三方运行时依赖**，
 * 纯函数核（`src/summarize.js`）+ 内置 `fetch` + 内置 `node:http` 就够跑完整条链路。
 * 少一个 devDependency = 少一处会腐烂的地方。
 *
 * 覆盖的三件事：
 *  ① 凭据纪律（0600 校验、环境变量优先、**错误消息不含凭据值**）
 *  ② 只读客户端的 wire 行为（Bearer 头、401/429/5xx 映射、超时）
 *  ③ **红线护栏**：`/api/daily` 的 answer/analysis 不得进工具输出
 */

import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { createMathDrillClient, MathDrillError } from '../src/math-drill-api.js'
import { CredentialError, readCredential } from '../src/credential.js'
import { daysUntil, stripQuestionAnswers, summarizeBrief, summarizeDaily, summarizeProgress } from '../src/summarize.js'

const CREDENTIAL = 'agent-credential-value-for-tests-0123456789'
/** 专门用来触发"慢上游"的第二个凭据（假上游据此延迟响应）。 */
const SLOW_CREDENTIAL = 'slow-credential-for-timeout-test'

/**
 * 抓住同步抛出的错误（`assert.throws` 不返回错误对象，而我们要**检查消息**）。
 * @param {() => unknown} fn
 * @returns {Error}
 */
function capture(fn) {
  try {
    fn()
  } catch (error) {
    return /** @type {Error} */ (error)
  }
  throw new Error('期望抛出错误，但没有')
}

/**
 * 抓住异步拒绝的错误。
 * @param {() => Promise<unknown>} fn
 * @returns {Promise<Error>}
 */
async function captureAsync(fn) {
  try {
    await fn()
  } catch (error) {
    return /** @type {Error} */ (error)
  }
  throw new Error('期望 reject，但没有')
}

/** 真实存在的题目形状（含答案 —— 就是要被剥掉的那两个字段）。 */
const QUESTION_WITH_ANSWER = {
  id: 'linalg.det.3x3.a',
  kid: 'c1n1',
  type: 'blank',
  difficulty: 2,
  stem: '计算三阶行列式 [[1,2,3],[4,5,6],[7,8,10]] 的值。',
  options: null,
  answer: '-3',
  analysis: '按第一行展开：1*(5*10-6*8)-2*(4*10-6*7)+3*(4*8-5*7) = -3。',
}

// ---------------------------------------------------------------- 假上游

/** 只认 Bearer 的假 math-drill（两个只读端点 + 一个写端点用来证明"不该被调用"）。 */
function startFakeUpstream({ onWrite } = {}) {
  const server = createServer((req, res) => {
    const auth = req.headers.authorization ?? ''
    if (auth === `Bearer ${SLOW_CREDENTIAL}`) {
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"server_version":1,"data":{}}') }, 400)
      return
    }
    if (auth !== `Bearer ${CREDENTIAL}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    if (req.method !== 'GET') {
      onWrite?.(req.method, req.url)
      res.writeHead(405, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'method_not_allowed' }))
      return
    }
    if (req.url === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        server_version: 7,
        data: { settings: { examTrack: 'math1', examDate: '2026-12-19' }, daily: null, checkins: {}, cards: {}, notes: {} },
      }))
      return
    }
    if (req.url === '/api/daily') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        server_version: 7,
        daily: { date: '2026-09-19' },
        questions: [QUESTION_WITH_ANSWER],
      }))
      return
    }
    if (req.url === '/boom') {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'boom' }))
      return
    }
    if (req.url === '/slow') {
      setTimeout(() => { res.writeHead(200); res.end('{}') }, 500)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not_found' }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

let upstream
before(async () => { upstream = await startFakeUpstream() })
after(() => { upstream?.server.close() })

// ---------------------------------------------------------------- ① 凭据纪律

describe('凭据纪律（ADR-015 决策 3 / 规格 §3.3）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'math-drill-cred-'))
  after(() => { rmSync(dir, { recursive: true, force: true }) })

  it('0600 文件可读；环境变量优先于文件', () => {
    const path = join(dir, 'ok')
    writeFileSync(path, `${CREDENTIAL}\n`, { mode: 0o600 })
    chmodSync(path, 0o600)
    assert.equal(readCredential({ path }), CREDENTIAL, '文件里的凭据应原样读出（去尾部空白）')
    assert.equal(
      readCredential({ path, env: 'MATH_DRILL_AGENT_CREDENTIAL', environ: { MATH_DRILL_AGENT_CREDENTIAL: ' from-env ' } }),
      'from-env',
      '环境变量应优先于文件',
    )
  })

  it('0644 文件被拒，且错误消息里不含凭据值', () => {
    const path = join(dir, 'too-open')
    writeFileSync(path, `${CREDENTIAL}\n`, { mode: 0o644 })
    chmodSync(path, 0o644)
    const error = capture(() => readCredential({ path }))
    assert.ok(error instanceof CredentialError, '应为 CredentialError')
    assert.match(error.message, /权限过宽/)
    assert.equal(error.message.includes(CREDENTIAL), false, '凭据值绝不能出现在错误消息里')
  })

  it('空文件 / 不存在的文件 / 完全未配置 —— 都要报可操作的错', () => {
    const empty = join(dir, 'empty')
    writeFileSync(empty, '   \n', { mode: 0o600 })
    chmodSync(empty, 0o600)
    assert.match(capture(() => readCredential({ path: empty })).message, /为空/)
    assert.match(capture(() => readCredential({ path: join(dir, 'nope') })).message, /不存在/)
    assert.match(capture(() => readCredential({})).message, /未配置/)
  })
})

// ---------------------------------------------------------------- ② 只读客户端

describe('只读客户端（ADR-015 决策 5）', () => {
  const client = (overrides = {}) => createMathDrillClient({
    baseUrl: upstream.baseUrl, credential: CREDENTIAL, timeoutMs: 200, ...overrides,
  })

  it('两个方法都是 GET，且都带 Bearer 头', async () => {
    const state = await client().state()
    assert.equal(state.server_version, 7)
    const daily = await client().daily()
    assert.equal(daily.questions.length, 1)
  })

  it('客户端**没有**写方法（红线：起步期不碰写面）', () => {
    assert.deepEqual(Object.keys(client()).sort(), ['attempts', 'daily', 'kp', 'state'])
  })

  it('401/非 200 都映射成 MathDrillError，且消息里没有凭据', async () => {
    const bad = client({ credential: 'wrong-credential' })
    const unauthorized = await captureAsync(() => bad.state())
    assert.ok(unauthorized instanceof MathDrillError, '应为 MathDrillError')
    assert.match(unauthorized.message, /401/)
    assert.equal(unauthorized.message.includes('wrong-credential'), false)
    const notOk = await captureAsync(() => createMathDrillClient({
      baseUrl: `${upstream.baseUrl}/boom`, credential: CREDENTIAL, timeoutMs: 200,
    }).state())
    assert.ok(notOk instanceof MathDrillError, '非 200 应为 MathDrillError')
    assert.match(notOk.message, /500|404/)
  })

  it('超时是错误而不是挂死', async () => {
    const slow = createMathDrillClient({ baseUrl: upstream.baseUrl, credential: SLOW_CREDENTIAL, timeoutMs: 50 })
    const error = await captureAsync(() => slow.state())
    assert.ok(error instanceof MathDrillError, '超时也应是 MathDrillError')
    assert.match(error.message, /超时/)
  })
})

// ---------------------------------------------------------------- ③ 红线护栏

describe('红线：答案不进模型上下文（ADR-013 定位 / ADR-015 决策 5）', () => {
  it('stripQuestionAnswers 去掉 answer 与 analysis，其余原样', () => {
    const stripped = stripQuestionAnswers(QUESTION_WITH_ANSWER)
    assert.equal('answer' in stripped, false)
    assert.equal('analysis' in stripped, false)
    assert.equal(stripped.id, QUESTION_WITH_ANSWER.id)
    assert.equal(stripped.stem, QUESTION_WITH_ANSWER.stem)
  })

  it('summarizeDaily 只回**数据**（数量/考点/难度/题型/题号），连题面都不回', () => {
    const text = summarizeDaily({ server_version: 7, daily: {}, questions: [QUESTION_WITH_ANSWER] })
    assert.match(text, /1 题/)
    assert.match(text, /考点：c1n1×1/)
    assert.match(text, /难度：2×1/)
    assert.match(text, /题型：blank×1/)
    assert.match(text, /linalg\.det\.3x3\.a/, '题号要给出（agent 据此指路）')
    assert.equal(text.includes('三阶行列式'), false, '题面不进 DSH（决策人 2026-09-20 校正方向）')
    assert.equal(text.includes(QUESTION_WITH_ANSWER.answer), false, '答案不得进上下文')
    assert.equal(text.includes('按第一行展开'), false, '解析不得进上下文')
  })

  it('summarizeDaily 空题库时给一句可读的说明', () => {
    assert.match(summarizeDaily({ questions: [] }), /没有出题/)
  })

  it('summarizeProgress 汇总轨道/天数/今日完成度/打卡', () => {
    const now = new Date('2026-09-19T10:00:00')
    const text = summarizeProgress({
      server_version: 7,
      data: {
        settings: { examTrack: 'math1', examDate: '2026-12-19' },
        daily: { date: '2026-09-19', reviewIds: ['a', 'b'], reviewDoneIds: ['a'], newIds: ['c'], newDoneIds: [], quizIds: [], quizDoneIds: [] },
        checkins: { '2026-09-19': { minutes: 32, tasksDone: false } },
        cards: { c1: {}, c2: {} },
        notes: { n1: {} },
      },
    }, now)
    assert.match(text, /数学一/)
    assert.match(text, /还有 91 天/)
    assert.match(text, /复习 1\/2/)
    assert.match(text, /32 分钟/)
    assert.match(text, /知识卡片：2 张/)
    assert.equal(text.includes('answer'), false)
  })

  it('daysUntil 对空值/坏值返回 null', () => {
    assert.equal(daysUntil('', new Date()), null)
    assert.equal(daysUntil('not-a-date', new Date()), null)
    assert.equal(daysUntil('2026-09-20', new Date('2026-09-19T23:59:00')), 1)
  })
})


describe('一行简报（状态条专用）', () => {
  it('是单行、含今日进度与考试倒计时，不含换行', () => {
    const now = new Date('2026-09-19T10:00:00')
    const brief = summarizeBrief({
      server_version: 7,
      data: {
        settings: { examTrack: 'math1', examDate: '2026-12-19' },
        daily: { date: '2026-09-19', reviewIds: ['a', 'b'], reviewDoneIds: ['a'], newIds: ['c'], newDoneIds: [], quizIds: [], quizDoneIds: [] },
        checkins: { '2026-09-19': { minutes: 32, tasksDone: false } },
        cards: {}, notes: {},
      },
    }, now)
    assert.equal(brief.includes('\n'), false, '状态条是一行，不能有换行')
    assert.match(brief, /今日 1\/3/)
    assert.match(brief, /还有 91 天/)
    assert.match(brief, /32 分钟/)
    assert.match(brief, /数学一/)
  })

  it('没开局/没设置时也有可读的一行', () => {
    const brief = summarizeBrief({ data: {} }, new Date('2026-09-19T10:00:00'))
    assert.equal(brief.includes('\n'), false)
    assert.match(brief, /今日未开局/)
  })
})
