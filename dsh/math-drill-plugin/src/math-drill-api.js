/**
 * math-drill HTTP 客户端 —— **几乎只读**：读方法若干 + **一个写方法**（`setDifficulty`）。
 *
 * ⚠️ 写面在 2026-09-21 由 **ADR-018** 主动开了**一个例外**：决策人要求"实际难度以 agent
 * 写入的为准"。在那之前本文件是"结构性只读"（只有 GET，根本没有写方法）—— **那句话从此不成立**，
 * 按 ADR-018 代价 2 降级为**可枚举白名单**：允许存在的写方法只有 `setDifficulty` 一个，
 * 由 `WRITE_METHOD_NAMES` 声明，测试盯着这个集合不许长大。
 *
 * 仍然**不做**的事：不写作答（必须走判定端点，ADR-007 的 judge 独占写入）、不写题、不写答案。
 *
 * 凭据走 `Authorization: Bearer <agent_value>`（ADR-015 决策 3）；错误消息只带状态码，
 * **不带凭据**。
 *
 * @module @math-drill/dsh-plugin/client
 */

/** math-drill 调用失败的统一错误类型。 */
export class MathDrillError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'MathDrillError'
  }
}

/**
 * **允许存在的写方法**（白名单真值）。加一个 = 必须先有 ADR（ADR-018 代价 2/4）。
 * @type {readonly string[]}
 */
export const WRITE_METHOD_NAMES = Object.freeze(['setDifficulty'])

/**
 * 建一个客户端（读方法若干 + 白名单里的写方法）。
 *
 * @param {object} options
 * @param {string} options.baseUrl - 服务根（如 `https://math.zhu2006.xyz`）。
 * @param {string} options.credential - 服务间凭据值。
 * @param {number} [options.timeoutMs] - 单次请求预算。
 * @param {typeof fetch} [options.fetchImpl] - 注入用（测试塞假上游）。
 * @returns {{
 *   state: () => Promise<object>, kp: () => Promise<object>,
 *   attempts: (days?: number) => Promise<object>, daily: () => Promise<object>,
 *   setDifficulty: (qid: string, difficulty: number, reason?: string) => Promise<object>,
 * }}
 */
export function createMathDrillClient({ baseUrl, credential, timeoutMs = 10_000, fetchImpl = fetch }) {
  const root = String(baseUrl).replace(/\/+$/, '')

  /** 发一个请求，把状态码翻译成人话（错误消息里**不带凭据**）。 */
  async function send(path, init) {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, timeoutMs)
    let response
    try {
      response = await fetchImpl(root + path, { ...init, signal: controller.signal })
    } catch (error) {
      const reason = /** @type {Error} */ (error)?.name === 'AbortError' ? '超时' : '网络错误'
      throw new MathDrillError(`连不上 ${root}（${reason}）`)
    } finally {
      clearTimeout(timer)
    }
    if (response.status === 401) {
      throw new MathDrillError('401：服务间凭据被拒（轮换过 token？按规格 §3.3 重新派生）')
    }
    if (response.status === 429) {
      throw new MathDrillError('429：被限速（agent 桶；降低调用频率后重试）')
    }
    if (response.status === 400) {
      throw new MathDrillError('400：入参被拒（难度必须是 1-4 的整数）')
    }
    if (response.status === 404) {
      throw new MathDrillError('404：题号不存在（先用 math_drill_today 或题库页确认题号）')
    }
    if (!response.ok) {
      throw new MathDrillError(`${response.status}：${path} 未返回 200`)
    }
    return /** @type {object} */ (await response.json())
  }

  return {
    /** `GET /api/state` —— 服务器持有的 blob（进度/设置/打卡）。 */
    state: () => send('/api/state', {
      method: 'GET',
      headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json' },
    }),
    /** `GET /api/kp` —— 知识点目录（把 kid 翻译成人话；ADR-016 决策 1）。 */
    kp: () => send('/api/kp', {
      method: 'GET',
      headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json' },
    }),
    /** `GET /api/attempts` —— 做题记录聚合（复盘用；只回判定/题号/考点，`day` 桶）。 */
    attempts: (days = 30) => send(`/api/attempts?days=${days}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json' },
    }),
    /** `GET /api/daily` —— 服务端当天题单（工具层会剥掉答案）。 */
    daily: () => send('/api/daily', {
      method: 'GET',
      headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json' },
    }),
    /**
     * `POST /m/qbank/set_difficulty` —— **唯一的写方法**（ADR-018）：记一条 agent 判定的难度。
     * 服务端 append-only、取最新生效；题库原生难度不被覆盖。
     */
    setDifficulty: (qid, difficulty, reason) => send('/m/qbank/set_difficulty', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ qid, difficulty, reason, src: 'dsh' }),
    }),
  }
}
