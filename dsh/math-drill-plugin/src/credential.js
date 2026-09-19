/**
 * 服务间凭据的读取（ADR-015 决策 3 / Bearer 规格 §3.3）。
 *
 * 三条纪律，全部写进代码而不是注释里：
 *  ① 凭据**永不打印**：本模块的任何错误消息都只含**路径与权限**，不含值；
 *  ② 文件必须 **0600**：权限过宽直接拒绝（BOUNDARY 把凭据落点列为禁地，
 *     而"笔记本上的配置文件即凭据文件"是这条规矩的具体形态）；
 *  ③ 环境变量优先于文件：便于临时轮换与 CI，但**不落盘**。
 *
 * @module @math-drill/dsh-plugin/credential
 */

import { readFileSync, statSync } from 'node:fs'

/** 凭据文件默认落点（相对 DSH home，由 index.js 用 dshHomePath 展开）。 */
export const DEFAULT_CREDENTIAL_RELATIVE_PATH = 'math-drill/agent-credential'

/** 凭据不可用时的统一错误类型（消息里**不含**凭据值）。 */
export class CredentialError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'CredentialError'
  }
}

/**
 * 读取服务间凭据：环境变量优先，其次 0600 文件。
 *
 * @param {object} options
 * @param {string | undefined} options.path - 凭据文件绝对路径（未配置则只认环境变量）。
 * @param {string | undefined} options.env - 环境变量名。
 * @param {NodeJS.ProcessEnv} [options.environ] - 环境变量表（测试注入用）。
 * @returns {string} 凭据值
 * @throws {CredentialError} 未配置 / 文件不存在 / 权限过宽 / 内容为空
 */
export function readCredential({ path, env, environ = process.env }) {
  if (typeof env === 'string' && env !== '') {
    const fromEnv = environ[env]
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  }
  if (typeof path !== 'string' || path === '') {
    throw new CredentialError(
      '未配置服务间凭据：请设置 credentialPath（0600 文件）或 credentialEnv（见 dsh/math-drill-plugin/README.md）',
    )
  }

  let stat
  try {
    stat = statSync(path)
  } catch {
    throw new CredentialError(`服务间凭据文件不存在：${path}（用规格 §3.3 的派生命令生成，chmod 600）`)
  }
  const mode = stat.mode & 0o777
  if ((mode & 0o077) !== 0) {
    throw new CredentialError(
      `服务间凭据文件权限过宽：${path} 是 ${mode.toString(8)}，要求 600（同组/他人可读 = 凭据泄露面）`,
    )
  }
  const value = readFileSync(path, 'utf8').trim()
  if (value === '') throw new CredentialError(`服务间凭据文件为空：${path}`)
  return value
}
