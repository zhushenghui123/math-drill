/* 验证降级路径：模型不支持原生 tools 参数 → 自动切文本工具协议 */
const http = require('http');
const path = require('path');
const BASE = path.join(__dirname, '..');

global.window = {};
require(path.join(BASE, 'js/tools.js'));
require(path.join(BASE, 'js/llm.js'));
global.Tools = global.window.Tools;
global.LLM = global.window.LLM;
require(path.join(BASE, 'js/agent.js'));
const Agent = global.window.Agent;

let pass = 0, fail = 0;
function truthy(label, got, extra) {
  if (got) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  (' + extra + ')' : '')); }
}

const PORT = 12400;
let callCount = 0;
let got400OnFirst = false;
let secondCallHadTools = null;
let secondCallHadProtocol = false;
let thirdCallSawToolResult = false;

const server = http.createServer(function (req, res) {
  if (req.url.indexOf('/models') >= 0) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-weak-model' }] }));
    return;
  }
  if (req.url.indexOf('/chat/completions') >= 0) {
    let body = '';
    req.on('data', function (c) { body += c; });
    req.on('end', function () {
      const j = JSON.parse(body);
      callCount++;

      // 模拟一个不认识 tools 参数的后端
      if (j.tools && j.tools.length) {
        got400OnFirst = true;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'tools is not supported by this model' } }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });

      if (callCount === 2) {
        secondCallHadTools = !!(j.tools && j.tools.length);
        secondCallHadProtocol = String(j.messages[0].content).indexOf('工具调用格式') >= 0;
        // 模型按文本协议吐出工具调用
        const payload = '我先查一下你最薄弱的考点。\n```tool\n{"name":"query_weakness","arguments":{"limit":3}}\n```';
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: payload } }] }) + '\n\n');
        res.write('data: [DONE]\n\n');
      } else {
        thirdCallSawToolResult = j.messages.some(function (m) {
          return m.role === 'user' && String(m.content).indexOf('执行结果') >= 0;
        });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '你的薄弱点是等价无穷小，我们从它开始。' } }] }) + '\n\n');
        res.write('data: [DONE]\n\n');
      }
      res.end();
    });
    return;
  }
  res.writeHead(404); res.end();
});

const mockCtx = {
  persona: function () { return 'strict'; },
  llmConf: function () { return { base: 'http://127.0.0.1:' + PORT + '/v1', model: 'mock-weak-model', key: '' }; },
  node: function (kid) { return { id: kid, title: '等价无穷小', difficulty: 2, exam: 'all', content: '正文', example: null, related: [] }; },
  allNodes: function () { return []; }, questionsOf: function () { return []; },
  attemptsOf: function () { return []; }, nodeStatus: function () { return 'new'; }, correctRate: function () { return null; },
  mistakeCards: function () { return []; }, publicQuestion: function (q) { return q; },
  weakNodes: function () { return [{ kid: 'c1n4', title: '等价无穷小', wrong: 3, accuracy: 25 }]; },
  progress: function () { return { trackName: '数学一', mastered: 0, learning: 0, untouched: 65, total: 65, streak: 0, accuracy7d: null, attempts7d: 0, daysLeft: 104, examDate: null, dueToday: 0 }; },
  notesOf: function () { return []; }, addNote: function () {}, markLearned: function () {}
};

server.listen(PORT, '127.0.0.1', async function () {
  console.log('\n=== 降级路径：模型不认 tools 参数 ===');
  const events = [];
  try {
    const out = await Agent.run({ kid: 'c1n4', history: [] }, '我该补哪里', mockCtx, {
      onAssistantStart: function () { return {}; },
      onAssistantDelta: function () {},
      onAssistantDone: function (b, t) { events.push('done:' + t.slice(0, 14)); },
      onAssistantDrop: function () {},
      onToolStart: function (tc) { events.push('tool:' + tc.name + (tc.fromText ? '(文本协议)' : '(原生)')); },
      onToolEnd: function () {}
    });

    console.log('\n事件序列：');
    events.forEach(function (e) { console.log('  · ' + e); });
    console.log('');

    truthy('第一次带 tools 被后端拒绝(400)', got400OnFirst);
    truthy('降级请求不再带 tools 参数', secondCallHadTools === false);
    truthy('降级时注入了文本工具协议说明', secondCallHadProtocol);
    truthy('从正文里识别出工具调用并执行', events.some(function (e) { return e.indexOf('tool:query_weakness') >= 0; }));
    truthy('标记为文本协议来源', events.some(function (e) { return e.indexOf('(文本协议)') >= 0; }));
    truthy('工具结果以 user 消息回灌', thirdCallSawToolResult);
    truthy('最终给出答案', out.content.indexOf('薄弱点是等价无穷小') >= 0);
    console.log('\n最终回答：' + out.content);
  } catch (e) {
    fail++; console.log('  ✗ 抛异常：' + e.message + '\n' + e.stack);
  }

  console.log('\n──────────────────────────────');
  console.log(fail === 0 ? '✅ 降级路径通过：' + pass + ' 项' : '❌ ' + fail + ' 项失败 / ' + pass + ' 项通过');
  server.close();
  process.exit(fail === 0 ? 0 : 1);
});
