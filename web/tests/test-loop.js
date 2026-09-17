/* 端到端验证 agent loop：用 mock 的 OpenAI 兼容服务模拟本地模型 */
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
function truthy(label, got) {
  if (got) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label); }
}

const PORT = 12399;
let callCount = 0;
let toolsSeenOnFirstCall = false;
let toolResultCountInSecondCall = 0;
let systemPromptSeen = '';

const server = http.createServer(function (req, res) {
  if (req.url.indexOf('/models') >= 0) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-local-model' }] }));
    return;
  }
  if (req.url.indexOf('/chat/completions') >= 0) {
    let body = '';
    req.on('data', function (c) { body += c; });
    req.on('end', function () {
      const j = JSON.parse(body);
      callCount++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });

      if (callCount === 1) {
        toolsSeenOnFirstCall = !!(j.tools && j.tools.length === 9);
        systemPromptSeen = (j.messages[0] && j.messages[0].content) || '';
        // 第一轮：先说话，再调工具
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '我先看看你的错题本。' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'get_mistakes', arguments: '{"limit":' } }] } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '3}' } }] } }] }) + '\n\n');
        res.write('data: [DONE]\n\n');
      } else {
        toolResultCountInSecondCall = j.messages.filter(function (m) { return m.role === 'tool'; }).length;
        // 第二轮：基于工具结果给最终答案
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '看到你有 1 道待攻克错题。' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '我们从极限的等价代换开始。' } }] }) + '\n\n');
        res.write('data: [DONE]\n\n');
      }
      res.end();
    });
    return;
  }
  res.writeHead(404); res.end();
});

const mockCtx = {
  persona: function () { return 'humor'; },
  llmConf: function () { return { base: 'http://127.0.0.1:' + PORT + '/v1', model: 'mock-local-model', key: '' }; },
  node: function (kid) { return { id: kid, title: '无穷小与等价代换', difficulty: 2, exam: 'all', content: '当 x→0 时 sin x ~ x。', example: '例', related: [] }; },
  allNodes: function () { return []; },
  questionsOf: function () { return []; },
  attemptsOf: function () { return [{ correct: false, date: '2026-09-13' }]; },
  nodeStatus: function () { return 'learning'; },
  correctRate: function () { return 0.5; },
  mistakeCards: function () { return [{ qid: 'q12', kid: 'c1n4', title: '无穷小', stem: 's', answer: '1', analysis: 'a', lapses: 2 }]; },
  publicQuestion: function (q) { return q; },
  weakNodes: function () { return [{ kid: 'c1n4', title: '无穷小与等价代换', wrong: 2, accuracy: 33 }]; },
  progress: function () { return { trackName: '数学一', mastered: 3, learning: 2, untouched: 60, total: 65, streak: 4, accuracy7d: 0.5, attempts7d: 8, daysLeft: 104, examDate: '2026-12-26', dueToday: 2 }; },
  notesOf: function () { return []; },
  addNote: function () {}, markLearned: function () {}
};

server.listen(PORT, '127.0.0.1', async function () {
  console.log('\n=== agent loop 端到端 ===');
  const events = [];
  try {
    const out = await Agent.run({ kid: 'c1n4', history: [] }, '我没听懂等价无穷小', mockCtx, {
      onAssistantStart: function () { events.push('assistant:start'); return {}; },
      onAssistantDelta: function () {},
      onAssistantDone: function (b, t) { events.push('assistant:done:' + t.slice(0, 12)); },
      onAssistantDrop: function () { events.push('assistant:drop'); },
      onToolStart: function (tc) { events.push('tool:start:' + tc.name); },
      onToolEnd: function (tc, r) { events.push('tool:end:' + tc.name + ':' + (r.ok ? 'ok' : 'fail')); }
    });

    console.log('\n事件序列：');
    events.forEach(function (e) { console.log('  · ' + e); });

    console.log('');
    truthy('模型收到了 9 个工具的 schema', toolsSeenOnFirstCall);
    truthy('模型收到了学情 system prompt（含薄弱考点）', systemPromptSeen.indexOf('无穷小与等价代换') >= 0 && systemPromptSeen.indexOf('连续打卡') >= 0);
    truthy('人设生效（段子手）', systemPromptSeen.indexOf('段子手') >= 0);
    truthy('调用了 get_mistakes 工具', events.indexOf('tool:start:get_mistakes') >= 0);
    truthy('工具执行成功', events.indexOf('tool:end:get_mistakes:ok') >= 0);
    truthy('工具结果已回灌给模型', toolResultCountInSecondCall === 1);
    truthy('共发起 2 轮请求（含工具往返）', callCount === 2);
    truthy('最终答案是第二轮的文字', out.content.indexOf('看到你有 1 道待攻克错题') >= 0);
    truthy('usedTools 记录正确', out.usedTools.length === 1 && out.usedTools[0].name === 'get_mistakes');
    truthy('流式增量已逐字推送', events.some(function (e) { return e.indexOf('assistant:done:我先看看你的错题本') >= 0; }));

    console.log('\n最终回答：' + out.content);
    console.log('消耗轮次：' + out.steps);
  } catch (e) {
    fail++;
    console.log('  ✗ 抛异常：' + e.message + '\n' + e.stack);
  }

  console.log('\n──────────────────────────────');
  console.log(fail === 0 ? '✅ agent loop 全部通过：' + pass + ' 项' : '❌ ' + fail + ' 项失败 / ' + pass + ' 项通过');
  server.close();
  process.exit(fail === 0 ? 0 : 1);
});
