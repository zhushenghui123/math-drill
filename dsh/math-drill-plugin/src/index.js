/**
 * 考研数学 × DSH 桥接插件（宿主半边）—— cordis 插件入口。
 *
 * 职责边界（ADR-015 决策 1/5）：
 *  · 只做**接线**：读凭据 → 开只读客户端 → 注册两个只读工具。agent 引擎（循环、工具调度、
 *    上下文压缩、会话存储）**一律用 DSH 现成的**，这里不写。
 *  · **只读**：写面（作答、判分、改 blob）不在本插件内；判定链路无 LLM。
 *  · **失败要软**：没配凭据时插件照常加载，工具回一句可操作的提示 —— 否则 DSH 起不来，
 *    "插件把宿主搞挂"比"功能没开"糟得多。
 *
 * @module @math-drill/dsh-plugin
 */

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { createMathDrillClient, MathDrillError } from './math-drill-api.js'
import { CredentialError, DEFAULT_CREDENTIAL_RELATIVE_PATH, readCredential } from './credential.js'
import { STATE_PATH, STATE_SCHEMA_VERSION } from './shared/contract.js'
import { summarizeBrief, summarizeDaily, summarizeProgress } from './summarize.js'
import { createMathDrillTools, MATH_DRILL_TOOL_NAMES } from './tools.js'

export { stripQuestionAnswers, summarizeBrief, summarizeDaily, summarizeProgress } from './summarize.js'
export { STATE_PATH, STATE_SCHEMA_VERSION } from './shared/contract.js'

/** cordis 诊断用的插件名（与 cordis.patch.yml 的 id 对应）。 */
export const name = 'math-drill-dsh'

/** 本插件需要的服务：工具面（agent 用）+ 宿主 web 服务器（客户端半边用）。其余数据面走 HTTP。 */
export const inject = ['tools', 'webServer']

/**
 * `/math` 斜杠命令的用法提示（也用于参数不认识时的报错文本）。
 */
export const MATH_COMMAND_USAGE = '用法：/math（看进度）· /math today（看今日题单）'

/**
 * 插件配置（部署间可变量；wire contract 固定）。
 * @typedef {object} Config
 * @property {string} baseUrl - math-drill 服务根。
 * @property {string} credentialPath - 服务间凭据文件（0600）。
 * @property {string} credentialEnv - 凭据环境变量名（优先）。
 * @property {number} timeoutMs - 单次请求预算。
 */

export const Config = z.object({
  baseUrl: z.string().default('https://math.zhu2006.xyz'),
  // 默认落点：$DSH_HOME/math-drill/agent-credential（见 cordis.patch.yml 的同名字段）
  credentialPath: z.string().default(dshHomePath(DEFAULT_CREDENTIAL_RELATIVE_PATH)),
  credentialEnv: z.string().default('MATH_DRILL_AGENT_CREDENTIAL'),
  timeoutMs: z.number().step(1).min(1).default(10_000),
})

/**
 * 挂载插件：解析凭据（**只在需要时**读文件）、注册只读工具。
 *
 * 设计取舍：凭据不在 `apply` 时就强制读 —— 没配凭据的用户照样能启动 DSH，
 * 每次工具调用时再读（文件轮换后无需重启）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - cordis 上下文。
 * @param {Config} config - 已过 schema 的插件配置。
 * @returns {Promise<void>}
 */
export async function apply(ctx, config) {
  const resolved = {
    baseUrl: config?.baseUrl ?? 'https://math.zhu2006.xyz',
    credentialPath: config?.credentialPath ?? dshHomePath(DEFAULT_CREDENTIAL_RELATIVE_PATH),
    credentialEnv: config?.credentialEnv ?? 'MATH_DRILL_AGENT_CREDENTIAL',
    timeoutMs: Number(config?.timeoutMs ?? 10_000),
  }

  /** 每次调用现取凭据（轮换后无需重启；文件权限每次校验）。 */
  function client() {
    const credential = readCredential({ path: resolved.credentialPath, env: resolved.credentialEnv })
    return createMathDrillClient({ baseUrl: resolved.baseUrl, credential, timeoutMs: resolved.timeoutMs })
  }

  const tools = createMathDrillTools({
    client: {
      state: async () => {
        try {
          return await client().state()
        } catch (error) {
          throw explain(error, resolved)
        }
      },
      daily: async () => {
        try {
          return await client().daily()
        } catch (error) {
          throw explain(error, resolved)
        }
      },
    },
  })

  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `${name}: tool ${tool.name}`)
  }

  // 只读摘要路由：给浏览器里的状态条用。
  // 为什么不让浏览器直连 math-drill：服务间凭据只应存在于宿主进程（凭据纪律）；
  // 浏览器拿到的是**已经剥掉答案**的文本摘要。
  // ⚠️ 方法名是 `register`（宿主 webserver 服务的真名，见 @deepseek-ai/dsh-host-webserver
  //   的 `WebServer.register(route)`）；2026-09-19 我在这里猜成 `registerRoute`，
  //   真实 profile **启动直接失败** —— 教训见 tests/wiring.test.mjs 的注释。
  const route = {
    kind: 'exact',
    path: STATE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: '只支持 GET（本路由只读）' }))
        return
      }
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      try {
        const mathDrill = client()
        const [state, daily] = await Promise.all([mathDrill.state(), mathDrill.daily()])
        res.writeHead(200)
        res.end(JSON.stringify({
          schemaVersion: STATE_SCHEMA_VERSION,
          ok: true,
          brief: summarizeBrief(state),
          text: `${summarizeProgress(state)}\n\n${summarizeDaily(daily)}`,
          fetchedAt: Date.now(),
        }))
      } catch (error) {
        // 失败也回 200 + ok:false：面板要把"怎么修"显示出来，而不是只显示一个红叉
        res.writeHead(200)
        res.end(JSON.stringify({
          schemaVersion: STATE_SCHEMA_VERSION,
          ok: false,
          error: explain(error, resolved).message,
        }))
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(route), `${name}: ${STATE_PATH}`)

  // ---- `/math` 斜杠命令（C4）
  // 契约（本机 0.1.1-rc.1 逐字核过）：`ctx.commands.register({ name, description, input:{hint}, handler })`，
  // handler 收 `CommandInvocation{ commandId, agent, rawInput, attachments, signal }`，
  // 返回 `{ kind:'success', text? }` 或 `{ kind:'error', text }`
  // （`packages/interaction/commands/src/index.ts:34-48`、`…/types.ts:27-34`；名称须匹配 `^[a-z][a-z0-9_-]*$`，`:28`）。
  // ⚠️ `commands` **不写成 inject**：与 locale 同一条教训 —— 硬 inject 会在缺该服务的宿主上把
  //    **工具与路由一起拖住**（静默不激活）；这里用 `ctx.get('commands')`，没有就只少一条命令。
  const commands = typeof ctx.get === 'function' ? ctx.get('commands') : undefined
  if (commands !== undefined) {
    const definition = {
      name: 'math',
      description: '考研数学：看进度，或看今天该做哪些题（只读）',
      input: { hint: '[today]' },
      handler: async (invocation) => {
        const argument = String(invocation?.rawInput ?? '').trim().toLowerCase()
        try {
          const mathDrill = client()
          if (argument === '' || argument === 'progress') {
            return { kind: 'success', text: summarizeProgress(await mathDrill.state()) }
          }
          if (argument === 'today') {
            return { kind: 'success', text: summarizeDaily(await mathDrill.daily()) }
          }
          return { kind: 'error', text: MATH_COMMAND_USAGE }
        } catch (error) {
          return { kind: 'error', text: explain(error, resolved).message }
        }
      },
    }
    ctx.effect(() => commands.register(definition), `${name}: /math`)
  }

  ctx.logger?.info?.(`${name}: 已注册 ${MATH_DRILL_TOOL_NAMES.join(' / ')}（只读；baseUrl=${resolved.baseUrl}）`)
}

/**
 * 把内部错误换成人能照着做的提示（**不回显凭据**）。
 *
 * @param {unknown} error - 抛出的错误。
 * @param {{ baseUrl: string, credentialPath: string, credentialEnv: string }} resolved - 已解析配置。
 * @returns {Error}
 */
function explain(error, resolved) {
  if (error instanceof CredentialError) {
    return new Error(
      `${error.message}\n（起点：在服务器上跑规格 §3.3 的派生命令，把结果写到 ${resolved.credentialPath} 并 chmod 600）`,
    )
  }
  if (error instanceof MathDrillError) return error
  return new Error(`math-drill 调用失败（${resolved.baseUrl}）：${error instanceof Error ? error.message : String(error)}`)
}
