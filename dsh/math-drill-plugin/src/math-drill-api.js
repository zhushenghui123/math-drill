/**
 * math-drill HTTP 客户端 —— **只读**（ADR-015 决策 5 / 代价 5）。
 *
 * 为什么只有 GET：起步期 agent 不接触数学服务的写面；写作答将来必须走判定端点
 * （ADR-007 的 judge 独占写入），插件**不提供**任何写方法 —— 让"不该写"成为结构性事实，
 * 而不是靠使用者的自觉。
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
 * 建一个只读客户端（两个方法，都走 GET）。
 *
 * @param {object} options
 * @param {string} options.baseUrl - 服务根（如 `https://math.zhu2006.xyz`）。
 * @param {string} options.credential - 服务间凭据值。
 * @param {number} [options.timeoutMs] - 单次请求预算。
 * @param {typeof fetch} [options.fetchImpl] - 注入用（测试塞假上游）。
 * @returns {{ state: () => Promise<object>, daily: () => Promise<object> }}
 */
export function createMathDrillClient({ baseUrl, credential, timeoutMs = 10_000, fetchImpl = fetch }) {
  const root = String(baseUrl).replace(/\/+$/, '')

  /**
   * GET 一个 JSON 端点。
   * @param {string} path
   * @returns {Promise<object>}
   */
  async function getJson(path) {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, timeoutMs)
    let response
    try {
      response = await fetchImpl(root + path, {
        method: 'GET',
        headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json' },
        signal: controller.signal,
      })
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
    if (!response.ok) {
      throw new MathDrillError(`${response.status}：${path} 未返回 200`)
    }
    return /** @type {object} */ (await response.json())
  }

  return {
    /** `GET /api/state` —— 服务器持有的 blob（进度/设置/打卡）。 */
    state: () => getJson('/api/state'),
    /** `GET /api/daily` —— 服务端当天题单（工具层会剥掉答案）。 */
    daily: () => getJson('/api/daily'),
  }
}
