/* 界面模式（web/js/layout.js）+ 手机样式隔离（web/assets/mobile.css）的自测
 *
 * 两条主线：
 *  ① 逻辑：自动按视口判定、手动覆盖优先且可持久化、循环顺序、按钮文案
 *  ② **不变量**：mobile.css 里所有样式必须锁在 html[data-layout="mobile"] 下
 *     —— 这条是机械护栏：以后谁往里塞一条全局规则，桌面端就会被悄悄改坏，
 *        而这个测试会立刻红（与 refcheck / test_dep_rules 同一套"纪律机械化"思路）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..');
const LAYOUT = path.join(WEB, 'js', 'layout.js');
const CSS = path.join(WEB, 'assets', 'mobile.css');
const src = fs.readFileSync(LAYOUT, 'utf8');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  ' + extra : '')); }
}

function makeEnv({ width = 1200, stored = null, button = false } = {}) {
  const store = stored === null ? {} : { md_layout: stored };
  const listeners = [];
  const attrs = {};
  const buttonEl = { textContent: '', title: '', addEventListener: (ev, fn) => { doc._click = fn; } };
  const doc = {
    readyState: 'complete',
    documentElement: {
      setAttribute: (k, v) => { attrs[k] = v; },
      getAttribute: k => (k in attrs ? attrs[k] : null),
    },
    // 注意：必须每次返回**同一个**对象（真实 DOM 就是这样），否则测试检查的是另一个实例
    getElementById: id => (button && id === 'layout-toggle' ? buttonEl : null),
    addEventListener: () => {},
  };
  const win = {
    innerWidth: width,
    document: doc,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    matchMedia: q => {
      const m = /max-width:\s*(\d+)px/.exec(q);
      const max = m ? Number(m[1]) : 1e9;
      return { matches: width <= max, addEventListener: (ev, fn) => listeners.push(fn), addListener: fn => listeners.push(fn) };
    },
    _store: store, _attrs: attrs,
    _button: buttonEl,
  };
  const ctx = vm.createContext({ window: win, Promise, Number, String, console });
  vm.runInContext(src, ctx, { filename: LAYOUT });
  return win;
}

console.log('\n=== 界面模式：逻辑 ===');

// ① 自动判定
{
  const phone = makeEnv({ width: 400 });        // 小米15 ≈ 400×890
  ok('视口 400px → 自动判为手机', phone.MDLayout.effective() === 'mobile',
     'html[data-layout]=' + phone._attrs['data-layout']);
  const desktop = makeEnv({ width: 1200 });
  ok('视口 1200px → 自动判为电脑', desktop.MDLayout.effective() === 'desktop');
  const edge = makeEnv({ width: 431 });
  ok('431px（刚过阈值）→ 电脑', edge.MDLayout.effective() === 'desktop');
  const edge2 = makeEnv({ width: 430 });
  ok('430px（正好阈值）→ 手机', edge2.MDLayout.effective() === 'mobile');
}

// ② 手动覆盖优先
{
  const w = makeEnv({ width: 1440 });
  w.MDLayout.set('mobile');
  ok('手动选手机：大屏也走手机版', w.MDLayout.effective() === 'mobile' && w._attrs['data-layout'] === 'mobile');
  const p = makeEnv({ width: 380 });
  p.MDLayout.set('desktop');
  ok('手动选电脑：小屏也走电脑版', p.MDLayout.effective() === 'desktop');
}

// ③ 循环顺序 + 持久化
{
  const w = makeEnv({ width: 1200 });
  w.MDLayout.set('auto');
  w.MDLayout.cycle(); const a = w.MDLayout.get();
  w.MDLayout.cycle(); const b = w.MDLayout.get();
  w.MDLayout.cycle(); const c = w.MDLayout.get();
  ok('循环顺序 auto → mobile → desktop → auto', a === 'mobile' && b === 'desktop' && c === 'auto',
     [a, b, c].join(' → '));
  w.MDLayout.set('mobile');
  const again = makeEnv({ width: 1440, stored: 'mobile' });
  ok('手动选择被记住（下次打开仍生效）', again.MDLayout.effective() === 'mobile');
  ok('标签文案', w.MDLayout.label('mobile') === '手机版' && w.MDLayout.label('desktop') === '电脑版' &&
     w.MDLayout.label('auto') === '自动');
}

// ④ 按钮接线
{
  const w = makeEnv({ width: 1200, button: true });
  const btn = w.document.getElementById('layout-toggle');
  ok('按钮初始文案', btn.textContent === '界面：自动', btn.textContent);
  w.document._click();
  ok('点一下切成手机版', btn.textContent === '界面：手机版' && w.MDLayout.effective() === 'mobile');
}

console.log('\n=== 手机样式隔离（不变量）===');
{
  const css = fs.readFileSync(CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) blocks.push(m[1].trim());

  // 允许不锁在 [data-layout="mobile"] 下的例外：切换按钮自身样式 + 无 JS 时隐藏它
  const ALLOW = [/#layout-toggle/, /html:not\(\[data-layout\]\)/];
  const leaks = blocks.filter(sel => {
    if (/data-layout="mobile"/.test(sel)) return false;
    return !ALLOW.some(a => a.test(sel));
  });
  ok('mobile.css 无"全局泄漏"规则（会污染电脑端）', leaks.length === 0,
     leaks.length ? '泄漏选择器: ' + leaks.slice(0, 3).join(' | ') : blocks.length + ' 个规则块全部合规');

  ok('index.html 引入 mobile.css', fs.readFileSync(path.join(WEB, 'index.html'), 'utf8')
     .includes('assets/mobile.css'));
  ok('index.html 在 head 里先加载 layout.js', /<script src="js\/layout\.js"><\/script>/.test(
     fs.readFileSync(path.join(WEB, 'index.html'), 'utf8')));
  ok('viewport 带 viewport-fit=cover（安全区）',
     /viewport-fit=cover/.test(fs.readFileSync(path.join(WEB, 'index.html'), 'utf8')));
}

console.log('');
if (fail) {
  console.log('❌ 有失败：' + (pass + fail) + ' 项，失败 ' + fail);
  process.exit(1);
}
console.log('✅ 全部通过：' + pass + ' 项');
