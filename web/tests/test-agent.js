/* 本地验证：表达式求值器 / 函数绘图 / 工具执行 / agent 提示词构建 */
const path = require('path');
const BASE = path.join(__dirname, '..');

global.window = {};
require(path.join(BASE, 'js/tools.js'));
require(path.join(BASE, 'js/llm.js'));
require(path.join(BASE, 'js/agent.js'));

const T = global.window.Tools;
const LLM = global.window.LLM;
const Agent = global.window.Agent;

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = (typeof want === 'number' && typeof got === 'number')
    ? Math.abs(got - want) < 1e-9
    : got === want;
  if (ok) { pass++; console.log('  ✓ ' + label + '  => ' + got); }
  else { fail++; console.log('  ✗ ' + label + '  => 得到 ' + got + '，期望 ' + want); }
}
function truthy(label, got) {
  if (got) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + '  (falsy)'); }
}

console.log('\n=== 1. 表达式求值器 ===');
const E = T.MathExpr;
eq('sin(pi/2)', E.evalAt('sin(pi/2)', 0), 1);
eq('cos(0)', E.evalAt('cos(0)', 0), 1);
eq('ln(e)', E.evalAt('ln(e)', 0), 1);
eq('log(100)', E.evalAt('log(100)', 0), 2);
eq('sqrt(16)', E.evalAt('sqrt(16)', 0), 4);
eq('x^2+2x+1  @x=3  (隐式乘法)', E.evalAt('x^2+2x+1', 3), 16);
eq('-x^2 @x=3  (一元负号优先级)', E.evalAt('-x^2', 3), -9);
eq('2^-1  (负指数)', E.evalAt('2^-1', 0), 0.5);
eq('1/x @x=4', E.evalAt('1/x', 4), 0.25);
eq('abs(-3)+1', E.evalAt('abs(-3)+1', 0), 4);
eq('sin(x)/x 极限点 @x=1e-6  (洛必达验证)', Math.round(E.evalAt('sin(x)/x', 1e-6) * 1e6) / 1e6, 1);
eq('3sin(x) 隐式乘法 @x=pi/2', E.evalAt('3sin(x)', Math.PI / 2), 3);
eq('(x+1)(x-1) 隐式乘法 @x=3', E.evalAt('(x+1)(x-1)', 3), 8);
eq('exp(-0)=1', E.evalAt('exp(0)', 0), 1);
eq('x^2^3 右结合 = x^(2^3) = x^8 @x=2', E.evalAt('x^2^3', 2), 256);
try { E.evalAt('alert(1)', 0); fail++; console.log('  ✗ 非法输入 alert(1) 竟然通过了'); }
catch (e) { pass++; console.log('  ✓ 非法输入被拦截：' + e.message); }
try { E.evalAt('x+', 0); fail++; console.log('  ✗ 残缺表达式竟然通过了'); }
catch (e) { pass++; console.log('  ✓ 残缺表达式被拦截'); }

console.log('\n=== 2. 函数绘图 ===');
const exprs = ['sin(x)/x', 'x^3-3x', 'ln(x)', '1/x', 'tan(x)', 'exp(-x^2)', 'x^2'];
exprs.forEach(function (ex) {
  const svg = T.drawGraphSVG(ex, {});
  if (svg && svg.indexOf('<svg') === 0 && svg.indexOf('</svg>') > 0 && svg.indexOf('<path') > 0) {
    pass++; console.log('  ✓ ' + ex + '  -> SVG ' + svg.length + ' 字节');
  } else {
    fail++; console.log('  ✗ ' + ex + '  绘图失败');
  }
});
truthy('非法表达式返回 null', T.drawGraphSVG('sin(', {}) === null);

console.log('\n=== 3. 工具执行（mock 学情数据）===');
const mockCtx = {
  persona: function () { return 'strict'; },
  llmConf: function () { return null; },
  node: function (kid) { return { id: kid, title: '两个重要极限（一）', difficulty: 3, exam: 'all', content: '正文', example: '例', related: ['c1n1'] }; },
  allNodes: function () { return [{ id: 'c1n2', title: '两个重要极限（一）', difficulty: 3, content: 'sin x / x' }]; },
  questionsOf: function () { return [{ id: 'q01', kid: 'c1n2', type: 'choice', stem: '题干', options: [{ k: 'A', t: '1' }], answer: 'A', analysis: '解析', difficulty: 2, sourceType: '真题改编', sourceYear: 2019 }]; },
  attemptsOf: function () { return [{ correct: true, date: '2026-09-13' }, { correct: false, date: '2026-09-13' }]; },
  nodeStatus: function () { return 'learning'; },
  correctRate: function () { return 0.5; },
  mistakeCards: function () { return [{ qid: 'q05', kid: 'c1n2', title: '极限', stem: 's', answer: '1', analysis: 'a', lapses: 2 }]; },
  publicQuestion: function (q) { return { id: q.id, kid: q.kid, type: q.type, stem: q.stem, options: q.options, difficulty: q.difficulty }; },
  weakNodes: function () { return [{ kid: 'c1n2', title: '两个重要极限（一）', wrong: 3, accuracy: 40 }]; },
  progress: function () { return { trackName: '数学一', mastered: 12, learning: 5, untouched: 51, total: 68, streak: 6, accuracy7d: 0.68, attempts7d: 25, daysLeft: 104, examDate: '2026-12-26', dueToday: 3 }; },
  notesOf: function () { return []; },
  addNote: function () {},
  markLearned: function () {}
};

Agent.names = null;
T.names.forEach(function (name) {
  const args = {
    query_weakness: { limit: 3 }, get_mistakes: { limit: 3 }, pick_question: { kid: 'c1n2' },
    get_node: { kid: 'c1n2' }, search_nodes: { query: '极限' }, get_progress: {},
    draw_graph: { expr: 'sin(x)/x' }, save_note: { kid: 'c1n2', text: '笔记' }, mark_mastered: { kid: 'c1n2' }
  }[name];
  const r = T.execute(name, args, mockCtx);
  if (r.ok) { pass++; console.log('  ✓ ' + name + '  -> ' + JSON.stringify(r.data).slice(0, 78) + (r.render ? ' [+SVG渲染]' : '')); }
  else { fail++; console.log('  ✗ ' + name + '  -> ' + r.error); }
});
const bad = T.execute('不存在的工具', {}, mockCtx);
truthy('未知工具返回友好错误', bad.ok === false && bad.error.indexOf('可用工具') > 0);

console.log('\n=== 4. system prompt 构建（学情是否真的进去了）===');
const sys = Agent.buildSystem({ kid: 'c1n2', history: [] }, mockCtx);
['已掌握 12', '连续打卡：6 天', '近 7 天正确率：68%', '两个重要极限（一）', '严格督学', 'query_weakness', 'draw_graph', '本考点'].forEach(function (k) {
  truthy('prompt 含「' + k + '」', sys.indexOf(k) >= 0);
});
console.log('  · prompt 总长度 ' + sys.length + ' 字符');

console.log('\n=== 5. compaction ===');
const longHist = [];
for (let i = 0; i < 30; i++) longHist.push({ role: i % 2 ? 'assistant' : 'user', content: '第' + i + '条消息内容' });
const comp = Agent.compactHistory(longHist, 12);
truthy('30 条压成 ' + comp.length + ' 条', comp.length === 13);
truthy('含压缩标记', comp[0].content.indexOf('已压缩') > 0);

console.log('\n=== 6. 工具调用文本兜底解析 ===');
const parsed = LLM.parseTextToolCalls('我先看看你的错题本。\n```tool\n{"name":"get_mistakes","arguments":{"kid":"c1n2","limit":5}}\n```');
truthy('从正文里解析出 1 个工具调用', parsed.length === 1 && parsed[0].name === 'get_mistakes');
eq('参数正确', JSON.stringify(parsed[0].args), '{"kid":"c1n2","limit":5}');
truthy('正文里的工具块被剥离', LLM.stripToolBlocks('我先看看你的错题本。\n```tool\n{"name":"x"}\n```').indexOf('```') < 0);

console.log('\n=== 7. 工具 schema 完整性 ===');
T.SCHEMA.forEach(function (s) {
  const f = s.function;
  if (f.name && f.description && f.parameters && f.parameters.type === 'object') { pass++; }
  else { fail++; console.log('  ✗ schema 不完整：' + f.name); }
});
console.log('  ✓ ' + T.SCHEMA.length + ' 个工具 schema 全部合法');

console.log('\n──────────────────────────────');
console.log(fail === 0 ? '✅ 全部通过：' + pass + ' 项' : '❌ ' + fail + ' 项失败 / ' + pass + ' 项通过');
process.exit(fail === 0 ? 0 : 1);
