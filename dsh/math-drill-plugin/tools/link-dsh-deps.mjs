/**
 * 把插件的 `@deepseek-ai/*` 同伴依赖**链接到本机已装的 DSH**。
 *
 * 为什么需要这一步（实测踩到的坑，2026-09-19）：
 *   插件以 `link:` 装进 profile 后，Node 解析 import 时用的是包的**真实路径**
 *   （仓库里的 `dsh/math-drill-plugin/`），父目录一路向上都到不了 DSH 的
 *   `$DSH_HOME/profiles/node_modules` 扁平回退目录 ⇒
 *   `Cannot find package '@deepseek-ai/dsh-home-paths'` ⇒ **整个插件树拒绝加载**
 *   （启动直接失败，不是"功能没开"）。
 *   生态里的同类插件（如 `@yuxianglin/dsh-bridge-browser`）靠**自带的 `node_modules`** 解决。
 *
 * 本脚本照同一条路走，但**不联网**：直接把版本一致性最强的来源 ——
 * 本机 DSH 的扁平回退目录（每个包一个符号链接）—— 链进插件的 `node_modules`。
 * 好处：`@deepseek-ai/*` 的版本**必然等于宿主正在用的那份**（比从 registry 装更安全）。
 *
 * 幂等：重复跑只补缺的链接；已存在且指向正确就跳过。
 * 用法：`node dsh/math-drill-plugin/tools/link-dsh-deps.mjs`
 *
 * @module @math-drill/dsh-plugin/tools/link-dsh-deps
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本插件在**加载期**真正 import 的宿主包（多一个都不链）。 */
const REQUIRED = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/schemastery',
]

/**
 * **测试期**依赖：只用真实契约给桩（stub）当锚，运行时不加载。
 *
 * 为什么值得单独列：2026-09-19 我把 `ctx.webServer.register` 猜成了 `registerRoute`，
 * 而测试里的桩用了同一个错名字 ⇒ 测试"通过"、真机**启动失败**。把桩挂在**真实服务类**上之后，
 * 名字错了就是测试失败，而不是用户那边的宿主起不来。
 */
const TEST_REQUIRED = [
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-commands',
]

/**
 * **构建期**依赖（只 `tools/build-client.mjs` 用，运行时不加载）。
 *
 * 为什么也走链接而不是 `pnpm add`：本机已经有 tsdown（别的插件的 pnpm store 里），
 * 联网装一遍既慢又可能撞上 registry 抖动；链接用的是**本机已验证可跑**的那一份。
 */
const BUILD_REQUIRED = ['tsdown']

/** 插件的包根（本文件在 `<root>/tools/` 下）。 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** DSH home：优先 `$DSH_HOME`，否则 `~/.dsh`（与 `@deepseek-ai/dsh-home-paths` 同语义）。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/**
 * 本机 DSH 安装根（`…/harness-versions/<hash>`）。
 *
 * 顺序：显式覆盖 → 启动器脚布里写的那个 → `harness-versions/` 下最新的一份。
 * 为什么不直接用 `$DSH_HOME/profiles/node_modules`：那不是真源 —— 它只是**扁平回退目录**，
 * 里面是指向安装目录的符号链接；本机实测它**整目录悬空**（435 条断链，指向已卸载的
 * AppImage 挂载点 `/tmp/.mount_…`），照它链接等于链到空气。
 *
 * @returns {string | undefined}
 */
function harnessRoot() {
  const override = process.env.MATH_DRILL_HARNESS_ROOT
  if (override !== undefined && override !== '') return override

  const shim = join(homedir(), '.local', 'bin', 'dsh')
  if (existsSync(shim)) {
    const match = readFileSync(shim, 'utf8').match(/"([^"]*harness-versions\/[^"]+)\/apps\//)
    if (match !== null && existsSync(match[1])) return match[1]
  }

  const versionsDir = join(homedir(), '.local', 'share', 'DeepSeek Harness', 'harness-versions')
  if (!existsSync(versionsDir)) return undefined
  const candidates = readdirSync(versionsDir)
    .map((name) => join(versionsDir, name))
    .filter((dir) => existsSync(join(dir, 'apps')))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return candidates[0]
}

/**
 * 扫安装树，建 `包名 → 目录` 索引（只收我们 REQUIRED 里那几个）。
 *
 * @param {string} root - 安装根。
 * @returns {Map<string, string>}
 */
function indexHarnessPackages(root) {
  // ⚠️ 白名单必须含 **TEST_REQUIRED**：2026-09-20 实测踩过 —— 只写 REQUIRED 时，
  // 那两份测试用包只能靠 profile 的扁平回退目录解析，而该目录是指向 AppImage 挂载点的
  // 临时链接（桌面端一退出就断）⇒ 桌面端没在跑时 setup 直接失败。
  const wanted = new Set([...REQUIRED, ...TEST_REQUIRED])
  const found = new Map()
  /** @type {string[]} */
  const candidates = []
  for (const group of ['packages', 'vendor']) {
    const groupDir = join(root, group)
    if (!existsSync(groupDir)) continue
    for (const level1 of readdirSync(groupDir)) {
      const level1Dir = join(groupDir, level1)
      if (!statSync(level1Dir).isDirectory()) continue
      candidates.push(level1Dir)
      for (const level2 of readdirSync(level1Dir)) candidates.push(join(level1Dir, level2))
    }
  }
  const nodeModules = join(root, 'node_modules', '@deepseek-ai')
  if (existsSync(nodeModules)) {
    for (const name of readdirSync(nodeModules)) candidates.push(join(nodeModules, name))
  }
  for (const dir of candidates) {
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) continue
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
      if (typeof pkg.name === 'string' && wanted.has(pkg.name) && !found.has(pkg.name)) {
        found.set(pkg.name, dir)
      }
    } catch { /* 坏 manifest 直接跳过（不是我们的目标） */ }
  }
  return found
}

/**
 * 在插件里建 `node_modules/<包名>` → 本机 DSH 同名包的符号链接。
 *
 * @returns {number} 退出码（0 = 全部就绪）。
 */
function main() {
  const root = harnessRoot()
  if (root === undefined) {
    process.stderr.write('找不到本机 DSH 安装（可用 MATH_DRILL_HARNESS_ROOT 显式指定安装根）\n')
    return 1
  }
  const fromInstall = indexHarnessPackages(root)
  const fallbackDir = join(dshHome(), 'profiles', 'node_modules')
  process.stdout.write(`DSH 安装根：${root}\n`)

  let missing = 0
  for (const name of [...REQUIRED, ...TEST_REQUIRED]) {
    // 优先用 profile 的扁平回退目录（它就是 profile 实际解析到的那一份），但它常常是断链
    const fallback = join(fallbackDir, name)
    const from = resolveExisting(fallback) ?? fromInstall.get(name)
    if (from === undefined) {
      process.stderr.write(`宿主里没有 ${name} —— 更新 DSH，或改本脚本的 REQUIRED\n`)
      missing += 1
      continue
    }
    const to = join(packageRoot, 'node_modules', name)
    mkdirSync(dirname(to), { recursive: true })
    if (existsSync(to) || isPathTaken(to)) {
      if (isSameLink(to, from)) {
        process.stdout.write(`✓ 已就绪 ${name}\n`)
        continue
      }
      rmSync(to, { recursive: true, force: true })
    }
    symlinkSync(from, to, 'dir')
    process.stdout.write(`+ 链接 ${name} → ${from}\n`)
  }

  // 构建期依赖：不在安装树里（官方只发运行时），去本机各插件的 pnpm store 里找
  for (const name of BUILD_REQUIRED) {
    const to = join(packageRoot, 'node_modules', name)
    if (isSameLink(to, findLocalPackage(name) ?? '')) {
      process.stdout.write(`✓ 已就绪 ${name}（构建期）\n`)
      continue
    }
    const from = findLocalPackage(name)
    if (from === undefined) {
      process.stderr.write(
        `找不到构建期依赖 ${name}（本机没有可用的一份）—— 手动装：`
        + `cd ${packageRoot} && pnpm add -D ${name}\n`,
      )
      missing += 1
      continue
    }
    mkdirSync(dirname(to), { recursive: true })
    rmSync(to, { recursive: true, force: true })
    symlinkSync(from, to, 'dir')
    process.stdout.write(`+ 链接 ${name}（构建期）→ ${from}\n`)
  }
  return missing === 0 ? 0 : 1
}

/**
 * 在本机的 `$DSH_HOME` 下找一份已安装的包（用于构建期依赖）。
 *
 * 只看形如 `…/node_modules/<name>/package.json` 的目录，取**路径里版本号最大**的一份
 * （pnpm store 目录名带版本；同机多份时用新的）。
 *
 * @param {string} name - 包名（不含 scope 时按裸名找）。
 * @returns {string | undefined} 包目录的真实路径。
 */
function findLocalPackage(name) {
  const found = []
  // 搜索根要**两个都找**：真实 home（第三方插件与它们的 pnpm store 在那儿）
  // + 当前 $DSH_HOME（可能是测试环境）。2026-09-20 踩过：只搜 $DSH_HOME 时，
  // 在干净的测试 home 里找不到 tsdown（它住在 ~/.dsh/dsh-browser 的 store 里）。
  const realHome = join(homedir(), '.dsh')
  const configured = dshHome()
  const roots = configured === realHome ? [realHome] : [realHome, configured]
  const queue = roots.map((dir) => ({ dir, depth: 0 }))
  while (queue.length > 0) {
    const { dir, depth } = queue.pop()
    if (depth > 6) continue
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const child = join(dir, entry.name)
      if (entry.name === 'node_modules') {
        const candidate = join(child, name)
        const real = resolveExisting(candidate)
        if (real !== undefined && existsSync(join(real, 'package.json'))) found.push(real)
        continue
      }
      // 不深入明显无关的大目录
      if (depth >= 6 || entry.name === 'sessions' || entry.name === 'storages') continue
      queue.push({ dir: child, depth: depth + 1 })
    }
  }
  if (found.length === 0) return undefined
  const versionOf = (path) => {
    const match = path.match(/[@/](\d+\.\d+\.\d+[^/]*)/)
    return match === null ? '' : match[1]
  }
  return found.sort((a, b) => versionOf(a).localeCompare(versionOf(b))).at(-1)
}

/** 路径（含符号链接）指向的东西真的存在时返回其真实路径，否则 undefined。 */
function resolveExisting(path) {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/** 路径已被占用（含**悬空**符号链接 —— `existsSync` 会漏判它，于是漏补）。 */
function isPathTaken(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** 该路径是否已经是指向 `target` 的符号链接（避免重复动盘）。 */
function isSameLink(path, target) {
  try {
    return lstatSync(path).isSymbolicLink() && readlinkSync(path) === target
  } catch {
    return false
  }
}

process.exit(main())
