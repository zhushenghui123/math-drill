/**
 * 客户端半边的构建配置 —— **镜像**官方 per-package 预设的 `clientConfig`。
 *
 * 为什么是"镜像"而不是"import 官方预设"：预设（`packages/client/tsdown.client.ts`）**不在安装包里**
 * （本机 DSH 安装树里没有它，只有上游仓有）；生态里的第三方插件都走镜像这条路
 * （`~/.dsh/skins/maid-atelier/build/tsdown.client.ts` 自述"mirrored from dsh-web-ui"）。
 * 本文件只保留我们真正需要的部分，并**去掉** CSS Modules 那段（我们不用 CSS 模块 ⇒ 不必装 lightningcss）。
 * 去掉的是"我们不用"的能力，**没有**改 loader 契约那三行（banner / intro / footer）—— 它们是产物格式的全部。
 *
 * 产物形态（loader 契约，逐字照搬）：
 *   `window.__ModuleLoader__.load({ id, factory: (require) => { … } })`
 * 执行时**只注册工厂**，模块体在 materialize 时才跑（见 dsh-client-modules 的 lazy CJS 模型）。
 *
 * @module @math-drill/dsh-plugin/tsdown.config
 */

import { defineConfig } from 'tsdown'
import { PLATFORM_MODULES } from './build/web-platform.ts'

/** 插件 id（同时也是产物里 `load({ id })` 的值，必须与 package name 一致）。 */
const PLUGIN_ID = '@math-drill/dsh-plugin'

/** 表内模块保持 external（由 loader 的表解析）；表外一律内联。 */
const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES]

export default defineConfig({
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  // 与宿主半边同一个 lib/ 目录（clean 必须关：默认清理会抹掉别的产物）
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  // 类型不从这条管线出（tsdown 会把 banner/footer 包进 .d.ts 里导致解析失败）
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  // 表外依赖必须内联：一个 require 不了的说明符 = 运行时必炸
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  // 内联的依赖里有读 process.env.NODE_ENV / import.meta.env.MODE 的（zustand 之类的浏览器惯用法）
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [{
    // 纯净闸门（官方同款规则的简化版）：表外的 `@deepseek-ai/*` **值导入**一律构建期报错 ——
    // 跨插件值导入要么内联出第二份运行时实例，要么 require 一个表里没有的东西。
    // 跨插件协作请走 cordis 服务（类型导入会被擦除，不到这里）。
    name: 'math-drill-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source)) return null
      throw new Error(
        `client bundle purity: "${source}" 既不是平台模块（web-platform.ts 的 PLATFORM_MODULES），`
        + '也不是类型导入 —— 跨插件值导入被禁止，请改走 cordis 服务',
      )
    },
  }],
  outputOptions: {
    // 产物名钉死 lib/client.js（与 package.json 的 exports["./client"] 对齐）
    entryFileNames: 'client.js',
    // ---- loader 契约：这三行是产物格式的全部，逐字照搬官方预设 ----
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})
