/* 存储桥 web/js/api.js 的自测（BOUNDARY §3③「新增」：511 项对最该改的层零覆盖）
 *
 * 覆盖 T4 的三处硬接缝：
 *   ① judge() 只发 POST /api/judge，且**前端不做任何比对**（只信服务端 correct）
 *   ② save() 去抖后 PUT /api/state，带 base_version（ADR-002 的版本仲裁前提）
 *   ③ 409 冲突 → 采用服务端最新版本号重放一次（§3.5）
 *   ④ loadCached()/clear() 仍是"唯一存储触点"，且键名不变（旧存档不丢）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const API = path.join(__dirname, '..', 'js', 'api.js');
const src = fs.readFileSync(API, 'utf8');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  ' + extra : '')); }
}

function makeEnv() {
  const store = {};
  const calls = [];
  const localStorage = {
    getItem: k => (store[k] === undefined ? null : store[k]),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  };
  const timers = [];
  const win = {
    navigator: { userAgent: 'Mozilla/5.0 (iPhone)' },
    localStorage,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    fetch: (url, opt) => {
      calls.push({ url, opt: opt || {} });
      const preset = win.__responses.shift() || { status: 200, body: {} };
      return Promise.resolve({
        status: preset.status,
        text: () => Promise.resolve(JSON.stringify(preset.body || {}))
      });
    },
    __responses: [],
    __flush: () => { const t = timers.splice(0); t.forEach(fn => fn()); }
  };
  const ctx = vm.createContext({ window: win, Promise, Date, JSON, Object, String, console });
  vm.runInContext(src, ctx, { filename: API });
  return { win, calls };
}

console.log('\n=== web/js/api.js 存储桥 ===');

(async function run() {
  // ① judge：只发 POST /api/judge，不回退到本地比对
  {
    const { win, calls } = makeEnv();
    win.__responses.push({ status: 200, body: { verdict: 'server_true', correct: true } });
    const r = await win.MDStore.judge('q1', '  -3  ');
    ok('judge() 打到 /api/judge', calls.length === 1 && calls[0].url === '/api/judge',
       JSON.stringify(calls.map(c => c.url)));
    ok('judge() 用 POST + JSON', calls[0].opt.method === 'POST' &&
       /application\/json/.test(calls[0].opt.headers['Content-Type']));
    const sent = JSON.parse(calls[0].opt.body);
    ok('judge() 上传 qid/raw_answer/device', sent.qid === 'q1' && sent.raw_answer === '  -3  ' &&
       sent.device === 'phone', JSON.stringify(sent));
    ok('judge() 返回服务端结论', r && r.correct === true);
  }

  // ② 服务端说 false 就是 false（前端没有"自己算一遍"的余地）
  {
    const { win } = makeEnv();
    win.__responses.push({ status: 200, body: { verdict: 'server_false', correct: false } });
    const r = await win.MDStore.judge('q1', '1');
    ok('judge() 服务端判 false 时前端照单全收', r.correct === false);
  }

  // ③ save：去抖后 PUT，带 base_version；不立即发请求（省流量、防抖）
  {
    const { win, calls } = makeEnv();
    win.__responses.push({ status: 200, body: { server_version: 7 } });
    win.MDStore.save({ cards: { a: 1 } });
    ok('save() 先写本地缓存（离线可用）', !!win.localStorage.getItem('kaoyan_math_tutor_v1'));
    ok('save() 去抖期间不发请求', calls.length === 0);
    win.__flush();
    await new Promise(res => setImmediate(res));
    ok('去抖后发 PUT /api/state', calls.length === 1 && calls[0].opt.method === 'PUT');
    const sent = JSON.parse(calls[0].opt.body);
    ok('PUT 带 base_version', sent.base_version === 0, JSON.stringify(sent.base_version));
    ok('PUT 带 data', sent.data && sent.data.cards && sent.data.cards.a === 1);
  }

  // ④ 409 冲突：采用服务端版本号后重放一次
  {
    const { win, calls } = makeEnv();
    win.__responses.push({ status: 409, body: { error: 'conflict', latest: { server_version: 9 } } });
    win.__responses.push({ status: 200, body: { server_version: 10 } });
    win.MDStore.save({ daily: { updated_at: 1 } });
    win.__flush();
    await new Promise(res => setImmediate(res));
    await new Promise(res => setImmediate(res));
    ok('409 后重放一次', calls.length === 2, JSON.stringify(calls.map(c => c.opt.method)));
    ok('重放用服务端最新版本号', JSON.parse(calls[1].opt.body).base_version === 9);
  }

  // ⑤ 触点：loadCached / clear 仍是唯三之一，键名不变
  {
    const { win } = makeEnv();
    ok('loadCached() 空缓存返回 null', win.MDStore.loadCached() === null);
    win.localStorage.setItem('kaoyan_math_tutor_v1', JSON.stringify({ x: 1 }));
    const got = win.MDStore.loadCached();
    ok('loadCached() 读同一个键（旧存档不丢）', got && got.x === 1);
    win.MDStore.clear();
    ok('clear() 清掉缓存', win.localStorage.getItem('kaoyan_math_tutor_v1') === null);
  }

  // ⑥ bootstrap：服务端有数据时以服务端为准
  {
    const { win } = makeEnv();
    win.localStorage.setItem('kaoyan_math_tutor_v1', JSON.stringify({ from: 'local' }));
    win.__responses.push({ status: 200, body: { server_version: 3, data: { from: 'server' } } });
    const r = await win.MDStore.bootstrap();
    ok('bootstrap 认服务端为真相源', r.source === 'server' && r.data.from === 'server');
    ok('bootstrap 覆盖本地缓存', win.MDStore.loadCached().from === 'server');
  }

  // ⑦ 题库：由服务端提供（BOUNDARY §0 替换 data-questions.js）
  {
    const { win, calls } = makeEnv();
    win.__responses.push({ status: 200, body: { questions: [{ id: 'q1', kid: 'l1n1' }] } });
    const qs = await win.MDStore.loadQuestions();
    ok('loadQuestions() 打到 /api/daily', calls[0].url === '/api/daily' && calls[0].opt.method === 'GET');
    ok('loadQuestions() 返回题目数组', Array.isArray(qs) && qs.length === 1 && qs[0].id === 'q1');
  }
  {
    const { win } = makeEnv();
    win.__responses.push({ status: 401, body: { error: 'unauthorized' } });
    let threw = null;
    try { await win.MDStore.loadQuestions(); } catch (e) { threw = e; }
    ok('未登录时 loadQuestions() 抛错（交给 UI 提示去 /setup）', !!threw && threw.code === 'unauthorized');
  }

  console.log('');
  if (fail) {
    console.log('❌ 有失败：' + (pass + fail) + ' 项，失败 ' + fail);
    process.exit(1);
  }
  console.log('✅ 全部通过：' + pass + ' 项');
})();
