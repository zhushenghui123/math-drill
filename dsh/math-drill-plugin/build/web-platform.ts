/**
 * 浏览器插件可用的**平台模块表**（DSH web loader 的种子表）。
 *
 * 为什么要有这个文件：客户端插件产物被 loader 在 `factory(require)` 里执行，`require`
 * 只能解析**表内**的模块；require 一个表外的 `@deepseek-ai/*` 是**必然的运行时抛错**。
 * 所以构建期必须把"能 require 什么"写死，并对超出表的 import 直接报错（见 tsdown.config.ts 的 purity 闸门）。
 *
 * 来源：镜像自 `~/.dsh/skins/maid-atelier/build/web-platform.ts`（该文件自述镜像自 dsh-web-ui 的
 * shell 种子表）。DSH 升级后请对照上游重取一次 —— 这张表是**快照不是契约**（ADR-015 代价 1）。
 *
 * @module @math-drill/dsh-plugin/build/web-platform
 */

export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
] as const

/** 平台模块说明符之一。 */
export type PlatformModule = (typeof PLATFORM_MODULES)[number]
