/* 连接测试回归：重点证明 testConnection 会带上 Authorization 头。
   修复前的 bug：listModels 不带 Key，云端 /models 稳定 401，
   于是「Key 填对了」也被报成「连不上 + 请启动本地推理服务」。 */
'use strict';
const http = require('http');
const path = require('path');

const BASE = path.join(__dirname, '..');
global.window = {};
global.location = { protocol: 'http:' };
require(path.join(BASE, 'js/llm.js'));
const LLM = global.window.LLM;

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  => ' + JSON.stringify(extra) : '')); }
}
function eq(a, b, label) { ok(a === b, label, { got: a, want: b }); }
function has(s, sub, label) { ok(String(s).indexOf(sub) >= 0, label, { got: String(s).slice(0, 170) }); }
function notHas(s, sub, label) { ok(String(s).indexOf(sub) < 0, label, { got: String(s).slice(0, 170) }); }

/* fetch 打桩：用来驱动「云端 base」的报错分支，不必真起一个非本机服务 */
const REAL_FETCH = global.fetch;
function stubFetch(handler) { global.fetch = handler; }
function restoreFetch() { global.fetch = REAL_FETCH; }

/* ---------------- mock 后端 ---------------- */
const GOOD = 'sk-good-key';
let mode = 'normal';
let lastReq = { path: '', auth: null };

const server = http.createServer((req, res) => {
  lastReq = { path: req.url, auth: req.headers['authorization'] || null };
  if (mode === 'legacy404' && req.url === '/models') { res.writeHead(404); return res.end('not found'); }
  if (mode === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>hi</html>'); }
  if (mode === 'noModels') {            // 网关不实现 /models，但对话是好的
    if (req.url.indexOf('/models') >= 0) { res.writeHead(404); return res.end('no'); }
    if ((req.headers['authorization'] || '') !== 'Bearer ' + GOOD) {
      res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":{}}');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }));
  }
  if (mode === 'noModelsBadModel') {    // 网关没 /models，且模型名填错了
    if (req.url.indexOf('/models') >= 0) { res.writeHead(404); return res.end('no'); }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'Model Not Exist' } }));
  }
  if (mode === 'empty') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [] }));
  }
  const auth = req.headers['authorization'] || '';
  if (auth !== 'Bearer ' + GOOD) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'Authentication Fails' } }));
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }));
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const P = server.address().port;
  const LOCALV1 = 'http://127.0.0.1:' + P + '/v1';
  const LOCAL = 'http://127.0.0.1:' + P;
  const CLOUDV1 = 'https://api.deepseek.com';       // 用于措辞断言（配合 fetch 打桩）

  console.log('\n=== 1. 核心回归：测试连接必须带上 Key ===');
  mode = 'normal';
  let r = await LLM.testConnection({ base: LOCALV1, model: 'deepseek-chat', key: GOOD });
  eq(lastReq.path, '/v1/models', '请求打到 /v1/models');
  eq(lastReq.auth, 'Bearer ' + GOOD, '★ 服务端确实收到了 Authorization 头');
  ok(r.ids.indexOf('deepseek-chat') >= 0, '返回了模型列表');
  eq(r.warn, '', '模型名在列表里，无警告');

  console.log('\n=== 2. 云端 + 错误 Key → 报「Key 被拒绝」，不甩锅本地服务 ===');
  stubFetch(async () => new Response(JSON.stringify({ error: { message: 'Authentication Fails' } }),
    { status: 401, headers: { 'Content-Type': 'application/json' } }));
  try {
    await LLM.testConnection({ base: CLOUDV1, model: 'deepseek-chat', key: 'sk-wrong' });
    ok(false, '应该抛错');
  } catch (e) {
    eq(e.reason, 'auth', '失败原因归类为 auth');
    eq(e.status, 401, '带上了状态码 401');
    has(e.message, 'Key 被拒绝', '提示指向 Key 问题');
    notHas(e.message, '本地推理服务', '★ 不再误导用户去启动本地服务');
    notHas(e.message, 'LM Studio', '★ 不提 LM Studio');
  }

  console.log('\n=== 3. 云端 + 完全没填 Key → 同样是 auth ===');
  try {
    await LLM.testConnection({ base: CLOUDV1, model: 'deepseek-chat', key: '' });
    ok(false, '应该抛错');
  } catch (e) {
    eq(e.reason, 'auth', '归类为 auth');
    has(e.message, 'Key 被拒绝', '提示指向 Key');
    has(e.message, '欠费', '提示里给了欠费这个常见原因');
  }
  restoreFetch();

  console.log('\n=== 4. 云端 + 网络不通 → 提示查网络/代理，不提本地服务 ===');
  stubFetch(async () => { throw new TypeError('Failed to fetch'); });
  try {
    await LLM.testConnection({ base: CLOUDV1, model: 'deepseek-chat', key: GOOD });
    ok(false, '应该抛错');
  } catch (e) {
    eq(e.reason, 'network', '归类为 network');
    has(e.message, '代理', '提示提到代理');
    notHas(e.message, '本地推理服务', '★ 云端不提本地服务');
  }

  console.log('\n=== 5. 云端 + 超时 → 归类 timeout ===');
  stubFetch(async () => { const er = new Error('aborted'); er.name = 'AbortError'; throw er; });
  try {
    await LLM.testConnection({ base: CLOUDV1, model: 'deepseek-chat', key: GOOD });
    ok(false, '应该抛错');
  } catch (e) {
    eq(e.reason, 'timeout', '归类为 timeout');
    has(e.message, '超时', '提示说明超时');
    notHas(e.message, '本地推理服务', '★ 云端不提本地服务');
  }
  restoreFetch();

  console.log('\n=== 6. base 不带 /v1 且 /models 404 → 自动回退 /v1/models ===');
  mode = 'legacy404';
  r = await LLM.testConnection({ base: LOCAL, model: 'deepseek-chat', key: GOOD });
  eq(lastReq.path, '/v1/models', '回退到 /v1/models 并成功');
  ok(r.ids.length === 2, '拿到 2 个模型');

  console.log('\n=== 7. 模型名不在列表 → 连上了但要给警告 ===');
  mode = 'normal';
  r = await LLM.testConnection({ base: LOCALV1, model: 'gpt-4o', key: GOOD });
  has(r.warn, 'gpt-4o', '警告里点名了填错的模型');
  has(r.warn, 'deepseek-chat', '警告里给出了可用模型');

  console.log('\n=== 8. 返回的不是 JSON（填错路径）→ 明确指出 ===');
  mode = 'html';
  try {
    await LLM.testConnection({ base: LOCALV1, model: 'x', key: GOOD });
    ok(false, '应该抛错');
  } catch (e) {
    eq(e.reason, 'notjson', '归类为 notjson');
    has(e.message, 'OpenAI 兼容', '提示说明要填 API 根地址');
  }
  mode = 'normal';

  console.log('\n=== 9. 本机地址网络不通 → 提示启动本地服务（措辞正确）===');
  try {
    await LLM.testConnection({ base: 'http://127.0.0.1:1/v1', model: 'x', key: GOOD });
    ok(false, '应该抛错');
  } catch (e) {
    eq(e.reason, 'network', '归类为 network');
    has(e.message, '本地推理服务', '本机地址 → 提示启动本地服务');
  }

  console.log('\n=== 10. file:// 下的本机地址 → 提示换 http 打开 ===');
  global.location = { protocol: 'file:' };
  try {
    await LLM.testConnection({ base: 'http://127.0.0.1:1/v1', model: 'x', key: '' });
    ok(false, '应该抛错');
  } catch (e) {
    has(e.message, 'http.server 8080', '★ 提示了正确的解法');
  }
  global.location = { protocol: 'http:' };

  console.log('\n=== 11. 通道识别与云端措辞全覆盖 ===');
  ok(LLM.isLocalBase('http://127.0.0.1:1234/v1'), '127.0.0.1 判为本地');
  ok(LLM.isLocalBase('http://localhost:1234/v1'), 'localhost 判为本地');
  ok(!LLM.isLocalBase('https://api.deepseek.com'), 'deepseek 判为云端');
  ok(!LLM.isLocalBase('https://api.moonshot.cn/v1'), 'moonshot 判为云端');
  ['auth', 'network', 'timeout', 'notjson', undefined].forEach(function (reason) {
    var h = LLM.connHint('https://api.deepseek.com', reason);
    notHas(h, '本地推理服务', '云端/' + reason + ' 不提本地服务');
    notHas(h, 'LM Studio', '云端/' + reason + ' 不提 LM Studio');
  });

  console.log('\n=== 12. listModels 契约不变（detectLocal 依赖）===');
  ok((await LLM.listModels(LOCALV1, 3000)) === null, '不带 Key → 401 → null（探测语义）');
  mode = 'html';
  ok((await LLM.listModels(LOCALV1, 3000)) === null, '非 JSON → null');
  mode = 'empty';
  ok((await LLM.listModels(LOCALV1, 3000)) === null, '★ 空列表 → null（否则探测会误判命中）');
  mode = 'normal';
  ok((await LLM.listModels(LOCALV1, 3000)) === null, '带 Key 才能通过，纯 listModels 拿不到 → null');

  console.log('\n=== 12b. 网关不实现 /models 时，改用真实对话判定 ===');
  mode = 'noModels';
  r = await LLM.testConnection({ base: LOCAL, model: 'deepseek-chat', key: GOOD });
  ok(r.viaChat === true, '★ 回退到对话探测并成功（不再假阴性）');
  eq(lastReq.path, '/chat/completions', '确实打了对话接口');
  eq(r.warn, '', '没有多余警告');

  mode = 'noModelsBadModel';
  r = await LLM.testConnection({ base: LOCAL, model: 'gpt-9', key: GOOD });
  ok(r.viaChat === true, '模型名错了也算连得上');
  has(r.warn, '模型名', '给出模型名警告');
  mode = 'normal';

  console.log('\n=== 13. probe 结构 ===');
  const pr = await LLM.probe(LOCALV1, GOOD, 3000);
  eq(pr.ok, true, 'probe 返回 ok');
  eq(pr.base, LOCALV1, 'probe 回填了 base');
  const pr2 = await LLM.probe(LOCALV1, 'bad', 3000);
  eq(pr2.ok, false, 'probe 失败返回 ok:false');
  eq(pr2.reason, 'auth', 'probe 失败带 reason');

  server.close();
  console.log('\n──────────────────────────────');
  console.log((fail === 0 ? '✅ 连接测试全部通过：' : '❌ 有失败：') + pass + ' 项' + (fail ? '，失败 ' + fail : ''));
  process.exit(fail ? 1 : 0);
})();
