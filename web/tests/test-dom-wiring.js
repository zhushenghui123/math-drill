/* 静态交叉验证：app.js 里 $('#id') 取用的每个 id，
   必须能在 app.js 生成的标记或 index.html 里找到。
   专治「改了 UI 结构但忘了改取值」这类只在运行时炸的错。 */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(REPO, 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

/* 只在「课堂」相关段落里检查 —— 这一段是这次整体重写的 */
const START = app.indexOf('function classOf(');
const END = app.indexOf('/* ----- 做题页 ----- */');
if (START < 0 || END < 0) { console.log('❌ 找不到课堂段落边界'); process.exit(1); }
const seg = app.slice(START, END);
console.log('课堂段落 ' + seg.length + ' 字符');

function uniq(a) { return Array.from(new Set(a)); }

// 1) 代码里取用的 id
const used = uniq((seg.match(/\$\('#([A-Za-z0-9_-]+)'\)/g) || [])
  .map(s => s.match(/#([A-Za-z0-9_-]+)/)[1]));
// 2) 代码里生成的 id（可能带拼接，所以宽松匹配 id="xxx" 与 id="xxx-' + ...）
const declaredInSeg = new Set((app.match(/id="([A-Za-z0-9_-]+)["']/g) || [])
  .map(s => s.match(/id="([A-Za-z0-9_-]+)/)[1]));
const declaredInHtml = new Set((html.match(/id="([A-Za-z0-9_-]+)"/g) || [])
  .map(s => s.match(/id="([A-Za-z0-9_-]+)"/)[1]));
// 3) 带字符串拼接的动态 id（例如 'c-st-' + k）→ 取前缀
const dynamicPrefixes = ['c-st-'];

let bad = 0, good = 0;
function chk(ok, label) { if (ok) { good++; console.log('  ✓ ' + label); } else { bad++; console.log('  ✗ ' + label); } }

console.log('\n=== 课堂段落里被取用的 id ===');
used.forEach(function (id) {
  chk(declaredInSeg.has(id) || declaredInHtml.has(id) ||
    dynamicPrefixes.some(p => id.indexOf(p) === 0), '#' + id);
});

// 4) 代码里用到的 class 选择器，必须在生成的标记里出现
const cls = uniq((seg.match(/querySelector\('\.([A-Za-z0-9_-]+)'\)/g) || [])
  .map(s => s.match(/\.([A-Za-z0-9_-]+)/)[1]));
const allMarkup = app + html;
console.log('\n=== 课堂段落里被取用的 class ===');
cls.forEach(function (c) { chk(allMarkup.indexOf(c) >= 0, '.' + c); });

// 5) onclick 里调用的 App.xxx 必须都定义过
const onclicks = uniq((allMarkup.match(/App\.([A-Za-z0-9_]+)\s*\(/g) || [])
  .map(s => s.match(/App\.([A-Za-z0-9_]+)/)[1]));
console.log('\n=== App.* 调用点是否有定义 ===');
onclicks.forEach(function (fn) { chk(new RegExp('App\\.' + fn + '\\s*=').test(app), 'App.' + fn); });

console.log('\n' + '─'.repeat(40));
console.log((bad === 0 ? '✅ DOM 接线检查通过：' : '❌ 有失败：') + good + ' 项' + (bad ? '，失败 ' + bad : ''));
process.exit(bad ? 1 : 0);
