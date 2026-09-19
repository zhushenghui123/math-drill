/**
 * 构建客户端半边（`lib/client.js`）—— 调用 tsdown，**不自己造打包器**。
 *
 * 为什么要有这层壳而不是直接 `tsdown`：tsdown 不在本插件的依赖里（**不联网装**），
 * 而是由 `link-dsh-deps.mjs` 从本机已有的一份（`~/.dsh/dsh-browser` 的 pnpm store）链进来。
 * 本脚本负责找到它、用 Node 直接跑它的 CLI（`dist/run.mjs`），并把结果报清楚。
 *
 * 用法：`node tools/build-client.mjs`（等价于 `pnpm build`）
 *
 * @module @math-drill/dsh-plugin/tools/build-client
 */

import { existsSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件包根（本文件在 `<root>/tools/` 下）。 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** tsdown 的 CLI 入口（相对 `node_modules/tsdown`）。 */
const TSDOWN_CLI = join('dist', 'run.mjs')

/** 产物路径。 */
const ARTIFACT = join(packageRoot, 'lib', 'client.js')

function main() {
  const tsdownDir = join(packageRoot, 'node_modules', 'tsdown')
  const cli = join(tsdownDir, TSDOWN_CLI)
  if (!existsSync(cli)) {
    process.stderr.write(
      `找不到 tsdown：${cli}\n`
      + '先跑 `node tools/link-dsh-deps.mjs`（它会把本机已有的 tsdown 链进来，不联网）。\n',
    )
    return 1
  }

  const result = spawnSync(process.execPath, [cli], { cwd: packageRoot, stdio: 'inherit' })
  if (result.status !== 0) {
    process.stderr.write(`tsdown 退出码 ${result.status}\n`)
    return result.status ?? 1
  }
  if (!existsSync(ARTIFACT)) {
    process.stderr.write(`构建没有产出 ${ARTIFACT}\n`)
    return 1
  }
  const { size } = statSync(ARTIFACT)
  process.stdout.write(`✅ 客户端半边已构建：lib/client.js（${size} 字节）\n`)
  return 0
}

process.exit(main())
