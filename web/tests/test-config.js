/* 验证「默认云端」的配置迁移：直接从 app.js 源码里抽出 defaults 和 load() 真实执行
 * 重点：不能把已经配好的用户配置冲掉
 */
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..', 'js', 'app.js');
const src = fs.readFileSync(APP, 'utf8');

function extract(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  if (a < 0) throw new Error('找不到起始标记：' + startMarker);
  const b = src.indexOf(endMarker, a + startMarker.length);
  if (b < 0) throw new Error('找不到结束标记：' + endMarker);
  return src.slice(a, b + endMarker.length);
}

const defaultsSrc = extract('var defaults = {', '\n  };');
const loadSrc = extract('function load() {', '\n  }');
const DB_KEY = 'kaoyan_math_tutor_v1';

console.log('\n=== 从源码抽出的片段确认 ===');
console.log('  defaults 片段 ' + defaultsSrc.length + ' 字符，含 kind: ' + /kind: 'cloud'/.test(defaultsSrc));
console.log('  load 片段 ' + loadSrc.length + ' 字符，含迁移标记: ' + /defaultsV2/.test(loadSrc));

/* T4 起：app.js 的 load() 不再直接读 localStorage，而是经 api.js 的 MDStore.loadCached()
 * （BOUNDARY §1：三处 localStorage 触点收敛到 api.js）。
 * 这里按**实况**补桩——MDStore.loadCached 的语义就是"读同一个 key 再 JSON.parse"。
 * 注意：这是"桩按实况修正"，不是放宽断言。 */
const build = new Function('localStorage', 'DB_KEY', 'MDStore',
  defaultsSrc + '\n' + loadSrc + '\nreturn load();');

function runLoad(stored) {
  const store = { kaoyan_math_tutor_v1: stored == null ? null : JSON.stringify(stored) };
  const mockLS = {
    getItem: function (k) { return store[k] === undefined ? null : store[k]; },
    setItem: function (k, v) { store[k] = v; },
    removeItem: function (k) { delete store[k]; }
  };
  const mockStore = {
    loadCached: function () {
      const raw = mockLS.getItem(DB_KEY);
      return raw ? JSON.parse(raw) : null;
    }
  };
  return build(mockLS, DB_KEY, mockStore);
}

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ✓ ' + label + '  => ' + JSON.stringify(got)); }
  else { fail++; console.log('  ✗ ' + label + '  => 得到 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want)); }
}

console.log('\n=== 场景 1：全新用户（localStorage 为空）===');
{
  const s = runLoad(null).settings.llm;
  eq('通道默认云端', s.kind, 'cloud');
  eq('真实 AI 默认开启', s.enabled, true);
  eq('Base 预填 DeepSeek', s.base, 'https://api.deepseek.com');
  eq('模型预填 deepseek-chat', s.model, 'deepseek-chat');
  eq('默认不记住 Key', s.rememberKey, false);
  eq('本地通道仍保留', s.localBase, 'http://127.0.0.1:1234/v1');
}

console.log('\n=== 场景 2：老用户，从没真正配过模型 ===');
{
  const s = runLoad({
    cards: {}, attempts: [], checkins: {}, daily: null, chats: {},
    settings: {
      examTrack: 'math1', dailyNew: 2, examDate: '',
      llm: { enabled: false, kind: 'local', base: 'http://127.0.0.1:1234/v1', model: '', localBase: 'http://127.0.0.1:1234/v1', localModel: '', cloudBase: 'https://api.deepseek.com', cloudModel: 'deepseek-chat' }
    }
  }).settings.llm;
  eq('迁移到云端', s.kind, 'cloud');
  eq('顺手打开开关', s.enabled, true);
  eq('切到云端 Base', s.base, 'https://api.deepseek.com');
  eq('切到云端模型', s.model, 'deepseek-chat');
}

console.log('\n=== 场景 3：已配好本地模型的老用户 —— 不能被冲掉 ===');
{
  const s = runLoad({
    cards: {}, attempts: [], checkins: {}, daily: null, chats: {},
    settings: {
      examTrack: 'math1', dailyNew: 2, examDate: '',
      llm: { enabled: true, kind: 'local', base: 'http://127.0.0.1:1234/v1', model: 'qwen2.5-14b', localBase: 'http://127.0.0.1:1234/v1', localModel: 'qwen2.5-14b', cloudBase: 'https://api.deepseek.com', cloudModel: 'deepseek-chat' }
    }
  }).settings.llm;
  eq('保持本地通道', s.kind, 'local');
  eq('本地模型没丢', s.model, 'qwen2.5-14b');
  eq('Base 没被改', s.base, 'http://127.0.0.1:1234/v1');
}

console.log('\n=== 场景 4：已记住 Key 的云端用户 —— 不能被冲掉 ===');
{
  const s = runLoad({
    cards: {}, attempts: [], checkins: {}, daily: null, chats: {},
    settings: {
      examTrack: 'math1', dailyNew: 2, examDate: '',
      llm: { enabled: true, kind: 'cloud', base: 'https://api.deepseek.com', model: 'deepseek-reasoner', cloudBase: 'https://api.deepseek.com', cloudModel: 'deepseek-reasoner', cloudKey: 'sk-abc123', rememberKey: true }
    }
  }).settings.llm;
  eq('通道仍是云端', s.kind, 'cloud');
  eq('自定义模型没丢', s.model, 'deepseek-reasoner');
  eq('记住的 Key 没丢', s.cloudKey, 'sk-abc123');
  eq('记住开关没被重置', s.rememberKey, true);
}

console.log('\n=== 场景 5：迁移只跑一次 —— 用户主动切回本地后不该被改回去 ===');
{
  const s = runLoad({
    cards: {}, attempts: [], checkins: {}, daily: null, chats: {},
    settings: {
      examTrack: 'math1', dailyNew: 2, examDate: '',
      llm: {
        enabled: true, kind: 'local', defaultsV2: true,
        base: 'http://127.0.0.1:1234/v1', model: '',
        localBase: 'http://127.0.0.1:1234/v1', localModel: '',
        cloudBase: 'https://api.deepseek.com', cloudModel: 'deepseek-chat',
        cloudKey: '', rememberKey: false
      }
    }
  }).settings.llm;
  eq('用户主动选的本地通道被尊重', s.kind, 'local');
  eq('Base 跟着通道走', s.base, 'http://127.0.0.1:1234/v1');
}

console.log('\n=== 场景 6：缺字段的老数据（更早的版本）===');
{
  const s = runLoad({
    cards: {}, attempts: [],
    settings: { llm: { enabled: false, base: 'https://api.deepseek.com', model: 'deepseek-chat' } }
  }).settings.llm;
  eq('补齐 kind', s.kind, 'cloud');
  eq('补齐 cloudKey', s.cloudKey, '');
  eq('补齐 rememberKey', s.rememberKey, false);
  eq('补齐 localBase', s.localBase, 'http://127.0.0.1:1234/v1');
}

console.log('\n──────────────────────────────');
console.log(fail === 0 ? '✅ 配置迁移全部通过：' + pass + ' 项' : '❌ ' + fail + ' 项失败 / ' + pass + ' 项通过');
process.exit(fail === 0 ? 0 : 1);
