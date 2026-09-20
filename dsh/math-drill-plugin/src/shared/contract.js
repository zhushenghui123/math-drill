/**
 * 宿主半边与客户端半边**共用的契约**（相对 import ⇒ 会被 tsdown 内联进浏览器产物）。
 *
 * 为什么要这个文件（2026-09-20 评审的阻塞项 Z1）：
 * 之前 `SUMMARY_PATH` 在宿主 `src/index.js:27` 与客户端 `src/client/index.ts:19` **各写一份**（两处真值），
 * 而"让客户端从宿主半边 import"是**不可执行**的方向 —— 宿主半边 import 了 `@deepseek-ai/dsh-tools` /
 * `schemastery` 等 Node 侧依赖，浏览器产物一旦 value-import 它，就会撞上
 * `build/web-platform.ts` 那道 purity 闸门（表外 `require` = 必然的运行时抛错）。
 *
 * 正解：把契约放进**谁都不依赖**的这小块，两边相对 import —— tsdown 内联，不落 require 表。
 * **本文件不得 import 任何 `@deepseek-ai/*`**（那就是把上面的问题换个地方重演）。
 *
 * @module @math-drill/dsh-plugin/shared/contract
 */

/** 宿主半边挂的只读状态路由；客户端半边从这里取数（两处真值到此为止）。 */
export const STATE_PATH = '/math-drill/summary'

/**
 * 响应体的 schema 版本。
 *
 * 为什么要它：响应形状在宿主（`src/index.js` 构造）与客户端（`src/client/index.ts` 的类型）各写一份，
 * 改一边忘了另一边就是运行时静默错位；带上版本号，客户端能显式判"这是不是我认识的形状"。
 * 规则：**只增不改** —— 加字段升 1（v2：加 `brief` 一行简报，给状态条用）；删字段/改语义才动大版本。
 */
export const STATE_SCHEMA_VERSION = 3

/**
 * 判定一个响应是不是本客户端认识的形状。
 *
 * @param {unknown} payload - 宿主返回的 JSON。
 * @returns {boolean} 是否是已知版本的状态响应。
 */
export function isStateResponse(payload) {
  if (payload === null || typeof payload !== 'object') return false
  const candidate = /** @type {{ schemaVersion?: unknown, ok?: unknown }} */ (payload)
  if (candidate.schemaVersion !== STATE_SCHEMA_VERSION) return false
  return typeof candidate.ok === 'boolean'
}
