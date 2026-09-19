/**
 * 客户端产物（`lib/client.js`）的**shape 断言** —— 把 loader 契约变成可测的东西。
 *
 * 为什么值得单独测：产物由构建管线生成，而"改坏了构建配置"这类错误**在浏览器里才炸**，
 * 到时候只看到"插件没出现"，很难定位。这里在仓库内就能证明四件事：
 *  ① 外壳是 loader 认的那三行（`load({id, factory})` + intro/footer）
 *  ② `require` 的说明符**全部在平台表内**（表外的 require = 运行时必炸）
 *  ③ 产物是 CJS（没有残留 ESM `import`）
 *  ④ 我们真的往**追加型**槽位注册了，且浏览器侧引用的宿主路由名与宿主半边一致
 *
 * 产物不存在时**跳过**而不是失败：还没构建不是代码缺陷（`node tools/build-client.mjs`）。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { PLATFORM_MODULES } from '../build/web-platform.ts'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifact = join(packageRoot, 'lib', 'client.js')

describe('客户端产物 shape（loader 契约）', () => {
  it('lib/client.js 存在（否则跳过，先跑 node tools/build-client.mjs）', (t) => {
    if (!existsSync(artifact)) {
      t.skip('lib/client.js 还没构建')
      return
    }
    const code = readFileSync(artifact, 'utf8')

    // ① 外壳
    assert.match(code, /^window\.__ModuleLoader__\.load\(\{/m, '必须是 loader 认的自注册外壳')
    assert.match(code, /id: "@math-drill\/dsh-plugin"/)
    assert.match(code, /factory: \(require\) => \{/)
    // 收尾：tsdown 会把 footer 重新缩进，所以按空白宽松匹配（格式由构建器决定，契约是那三行本身）
    assert.match(code, /return module\.exports;\s*\}\s*\}\);/)

    // ② 表外 require = 运行时必炸
    const required = [...code.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1])
    assert.ok(required.length > 0, '至少要 require react')
    for (const specifier of new Set(required)) {
      assert.ok(
        PLATFORM_MODULES.includes(specifier),
        `require("${specifier}") 不在平台模块表内 —— loader 回答不了，运行时必抛`,
      )
    }

    // ③ CJS：factory 体内不该再有 ESM import
    assert.equal(/^\s*import\s/m.test(code), false, '产物里不该残留 ESM import')

    // ④ 注册点与宿主路由名
    assert.match(code, /conversation\.input\.dock/, '应注册到追加型槽位')
    assert.match(code, /\/math-drill\/summary/, '浏览器引用的宿主路由名要对得上')
  })
})
