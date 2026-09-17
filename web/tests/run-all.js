#!/usr/bin/env node
/* 全量回归入口 —— 零依赖，只用 Node 内置模块。
 *
 *   node tests/run-all.js            跑全部
 *   node tests/run-all.js classroom  只跑名字含 classroom 的
 *
 * 每个测试脚本都是独立进程（它们各自 process.exit），
 * 这里负责汇总，让"到底绿没绿"一眼可见。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const filter = process.argv[2] || '';

const files = fs.readdirSync(DIR)
  .filter(f => /^test-.*\.js$/.test(f))
  .filter(f => !filter || f.indexOf(filter) >= 0)
  .sort();

if (!files.length) {
  console.log('没有匹配的测试文件。可用：' +
    fs.readdirSync(DIR).filter(f => /^test-.*\.js$/.test(f)).join('、'));
  process.exit(1);
}

let totalPass = 0, totalFail = 0;
const rows = [];

for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(DIR, f)], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  // 测试脚本最后一行统一是「✅ ...：N 项」或「❌ 有失败：N 项，失败 M」
  const okMatch = out.match(/✅[^\n]*?(\d+)\s*项/);
  const badMatch = out.match(/❌[^\n]*?(\d+)\s*项[^\n]*?失败\s*(\d+)/);

  let p = 0, fa = 0;
  if (badMatch) { p = parseInt(badMatch[1], 10); fa = parseInt(badMatch[2], 10); }
  else if (okMatch) { p = parseInt(okMatch[1], 10); fa = 0; }
  else { fa = 1; }                       // 脚本崩了，没输出汇总行

  totalPass += p; totalFail += fa;
  rows.push({ name: f, pass: p, fail: fa, crashed: !okMatch && !badMatch });

  const tag = fa === 0 ? '✓' : '✗';
  console.log(tag + ' ' + f.replace(/\.js$/, '').padEnd(18) +
    (fa === 0 ? p + ' 项' : p + ' 项，失败 ' + fa));

  if (fa !== 0) {
    // 把失败行和崩溃堆栈带出来，不然只看到一个数字没法排查
    out.split('\n').filter(l => l.indexOf('✗') >= 0 || /Error|error:/.test(l))
      .slice(0, 12).forEach(l => console.log('    ' + l.trim()));
  }
}

console.log('─'.repeat(46));
console.log((totalFail === 0 ? '✅ 全部通过：' : '❌ 有失败：') + totalPass + ' 项' +
  (totalFail ? '，失败 ' + totalFail : ''));
process.exit(totalFail ? 1 : 0);
