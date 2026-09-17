/* 多智能体课堂回归测试
   重点不是"函数返回了 ok"，而是：
   1) 丙调 look_up 工具，拿到的内容**确实被水平限制**（结构性无知，不是提示词演的）
   2) 三个学生是**独立调用**（并发首轮 = 3 个独立请求）
   3) 调度器按规则工作（举手优先、保证覆盖、到量收束）
*/
'use strict';
const http = require('http');
const path = require('path');

const BASE = path.join(__dirname, '..');
global.window = {};
global.location = { protocol: 'http:' };
require(path.join(BASE, 'js/llm.js'));
global.LLM = global.window.LLM;
require(path.join(BASE, 'js/tools.js'));
global.Tools = global.window.Tools;
require(path.join(BASE, 'js/classroom.js'));
const Classroom = global.window.Classroom;

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  => ' + JSON.stringify(extra).slice(0, 220) : '')); }
}
function eq(a, b, label) { ok(a === b, label, { got: a, want: b }); }
function has(s, sub, label) { ok(String(s).indexOf(sub) >= 0, label, { got: String(s).slice(0, 200) }); }
function notHas(s, sub, label) { ok(String(s).indexOf(sub) < 0, label, { got: String(s).slice(0, 200) }); }

/* ---------------- 假的学情数据 ---------------- */
const NODES = {
  c1n4: {
    id: 'c1n4', title: '无穷小与等价代换', difficulty: 2,
    content: '当 x 趋于 0 时常用等价无穷小：sin x 等价于 x，tan x 等价于 x，1-cos x 等价于 x^2/2。\n\n等价代换只能用于乘除因子，加减中慎用。',
    example: '求 lim (1-cos x)/x^2：分子等价于 x^2/2，故极限为 1/2。',
    related: ['c1n3']
  },
  c1n3: { id: 'c1n3', title: '两个重要极限（二）', content: '第二个重要极限是 e。', example: '略。', related: [] }
};
const QS = {
  c1n4: [{
    id: 'q1', kid: 'c1n4', type: 'choice', difficulty: 2,
    stem: '求极限 lim (tan x - sin x) / x^3',
    options: [{ k: 'A', t: '1/2' }, { k: 'B', t: '0' }, { k: 'C', t: '1' }],
    answer: 'A', analysis: 'tan x - sin x 等价于 x^3/2，所以是 1/2。'
  }]
};

function makeCtx(conf) {
  return {
    persona: () => 'strict',
    llmConf: () => conf,
    node: (kid) => NODES[kid] || null,
    allNodes: () => Object.values(NODES),
    questionsOf: (kid) => QS[kid] || [],
    attemptsOf: () => [],
    nodeStatus: () => 'new',
    correctRate: () => null,
    mistakeCards: () => [{
      qid: 'q1', kid: 'c1n4', title: '无穷小与等价代换',
      stem: '求极限 lim (tan x - sin x) / x^3',
      answer: 'A', analysis: 'tan x - sin x 等价于 x^3/2。', lapses: 3
    }],
    publicQuestion: (q) => q,
    weakNodes: () => [{ kid: 'c1n4', title: '无穷小与等价代换', wrong: 3, accuracy: 25 }],
    progress: () => ({ total: 68, mastered: 5 }),
    notesOf: () => [],
    addNote: () => {},
    markLearned: () => {}
  };
}

/* ---------------- mock 模型服务 ---------------- */
let studentTools = true;          // 学生是否调用工具
let directorQueue = [];           // 调度器依次返回什么
const log = { calls: [], toolResults: [], studentMsgs: {} };

function classify(messages) {
  const sys = (messages.find(m => m.role === 'system') || {}).content || '';
  if (sys.indexOf('调度器') >= 0) return 'director';
  if (sys.indexOf('扮演考研数学学习小组里的一个学生') >= 0) {
    if (sys.indexOf('你是学生甲') >= 0) return 'student:smart';
    if (sys.indexOf('你是学生乙') >= 0) return 'student:average';
    if (sys.indexOf('你是学生丙') >= 0) return 'student:weak';
    return 'student:unknown';
  }
  if (sys.indexOf('你是一位考研数学老师') >= 0) return 'teacher';
  return 'unknown';
}

function sse(res, text) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const parts = [];
  for (let i = 0; i < text.length; i += 6) parts.push(text.slice(i, i + 6));
  for (const p of parts) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: p } }] }) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}
function json(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch (e) { }
    const kind = classify(body.messages || []);
    log.calls.push(kind);

    if (kind === 'director') {
      const next = directorQueue.length ? directorQueue.shift() : 'END';
      return json(res, { choices: [{ message: { content: JSON.stringify({ next: next, why: '测试' }) } }] });
    }

    if (kind.startsWith('student:')) {
      const role = kind.split(':')[1];
      const hasToolResult = (body.messages || []).some(m => m.role === 'tool');
      // 记录这次请求里看到的工具结果，供断言检查
      (body.messages || []).filter(m => m.role === 'tool').forEach(m => {
        log.toolResults.push({ role: role, content: m.content });
      });
      log.studentMsgs[role] = body.messages;

      if (studentTools && !hasToolResult) {
        return json(res, {
          choices: [{
            message: {
              content: '',
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'look_up', arguments: '{"what":"定义"}' } }]
            }
          }]
        });
      }
      const said = { smart: '我直接看比值就行，这是 1/2。', average: '那为什么不能拆开代换呢？', weak: '我觉得是 0 吧，两个都换成 x 就减没了。' }[role] || '……';
      return json(res, { choices: [{ message: { content: said } }] });
    }

    // 老师
    const isLesson = (body.messages.find(m => m.role === 'system') || {}).content.indexOf('第 ') >= 0;
    return sse(res, isLesson ? '这一步讲完了。谁能说说这里为什么要小心？' : '这道题我们来看一下：tan x 减 sin x 除以 x 的三次方。大家觉得是多少？');
  });
});

function reset(conf) { log.calls = []; log.toolResults = []; log.studentMsgs = {}; }

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const conf = { base: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'mock', key: '', kind: 'local' };
  const ctx = makeCtx(conf);

  console.log('\n=== 1. firstSentence：丙能看到的"第一句定义" ===');
  const fs1 = Classroom.firstSentence(NODES.c1n4.content);
  has(fs1, '等价无穷小', '取到了定义句');
  notHas(fs1, '只能用于乘除因子', '没把后半段带出来');
  eq(Classroom.firstSentence(''), '', '空串安全');
  eq(Classroom.firstSentence('没有句号的一句话'), '没有句号的一句话', '无句号时整段返回');

  console.log('\n=== 2. levelMaterial：三档裁剪 ===');
  const m0 = Classroom.levelMaterial(ctx, 'c1n4', 0);
  eq(m0.definition, fs1, 'level 0 只给定义');
  eq(m0.content, undefined, '★ level 0 没有正文');
  eq(m0.example, undefined, '★ level 0 没有例题');
  const m1 = Classroom.levelMaterial(ctx, 'c1n4', 1);
  has(m1.content, '乘除因子', 'level 1 有完整正文');
  has(m1.example, '1/2', 'level 1 有例题');
  eq(m1.relatedPoints, undefined, '★ level 1 没有关联考点');
  const m2 = Classroom.levelMaterial(ctx, 'c1n4', 2);
  ok(Array.isArray(m2.relatedPoints) && m2.relatedPoints.length === 1, 'level 2 有关联考点');
  eq(m2.relatedPoints[0], '两个重要极限（二）', '关联考点解析成了标题');

  console.log('\n=== 3. 学生 system：差异来自机制不是形容词 ===');
  const sess = { kid: 'c1n4', question: QS.c1n4[0], mode: 'debate', turns: [], spoken: [], memory: {} };
  const sysSmart = Classroom.buildStudentSystem('smart', sess, ctx);
  const sysWeak = Classroom.buildStudentSystem('weak', sess, ctx);
  has(sysSmart, '你是学生甲', '甲的身份正确');
  has(sysWeak, '你是学生丙', '丙的身份正确');
  has(sysSmart, '乘除因子', '★ 甲的系统提示里有完整正文');
  notHas(sysWeak, '乘除因子', '★ 丙的系统提示里没有完整正文');
  has(sysWeak, '你只记得这一句', '丙被明确告知知识边界');
  has(sysWeak, '干扰项', '★ 丙的错误来源是真实干扰项');
  has(sysSmart, 'look_up', '工具清单已注入');
  has(sysWeak, '禁止出现「作为 AI」', '★ AI 腔是被明令禁止的，不是被鼓励的');
  has(sysSmart, '不替老师讲课', '禁止学生变成老师');

  console.log('\n=== 4. parseDirector ===');
  eq(Classroom.parseDirector('{"next":"weak"}'), 'weak', '正常解析');
  eq(Classroom.parseDirector('```json\n{"next":"smart","why":"x"}\n```'), 'smart', '带代码块也能解析');
  eq(Classroom.parseDirector('{"next":"END"}'), null, 'END → null');
  eq(Classroom.parseDirector('{"next":"teacher"}'), 'teacher', 'teacher 可被选中');
  eq(Classroom.parseDirector('胡说八道'), undefined, '解析不了 → undefined（交给兜底）');
  eq(Classroom.parseDirector('{"next":"me"}'), undefined, '不认识的 id → undefined');

  console.log('\n=== 5. localSchedule：本地规则短路 ===');
  const s1 = { spoken: [], pendingHand: null, minTurns: 3, maxTurns: 6 };
  eq(Classroom.localSchedule(s1), 'smart', '没人说过 → 优先让甲开口');
  eq(Classroom.localSchedule({ spoken: [{ role: 'smart' }], minTurns: 3, maxTurns: 6 }), 'average', '甲说过 → 轮到乙');
  eq(Classroom.localSchedule({ spoken: [{ role: 'smart' }, { role: 'average' }], minTurns: 3, maxTurns: 6 }), 'weak', '保证丙也开口');
  eq(Classroom.localSchedule({ spoken: [{ role: 'smart' }, { role: 'average' }, { role: 'weak' }], minTurns: 3, maxTurns: 6 }), undefined, '都说过且没到量 → 交给调度器');
  eq(Classroom.localSchedule({ spoken: new Array(6).fill({ role: 'smart' }), minTurns: 3, maxTurns: 6 }), null, '到量 → 结束');
  eq(Classroom.localSchedule({ spoken: [{ role: 'smart' }], pendingHand: { role: 'weak', question: 'x' }, minTurns: 3, maxTurns: 6 }), 'teacher', '★ 有人举手 → 老师优先，不问调度器');

  console.log('\n=== 6. fallbackRotate 不连着同一个人 ===');
  const fr = Classroom.fallbackRotate({ spoken: [{ role: 'smart' }] });
  ok(fr !== 'smart', '不会让甲连说两次', fr);

  console.log('\n=== 7. 学生 agent loop：真的调了工具 ===');
  studentTools = true;
  reset(conf);
  const out = await Classroom.studentTurn('weak', sess, ctx, {});
  eq(out.role, 'weak', '返回了角色');
  eq(out.tools.length, 1, '执行了 1 次工具调用');
  eq(out.tools[0].name, 'look_up', '调的是 look_up');
  has(out.text, '0', '丙说出了他的错误结论');

  console.log('\n=== 8. ★ 核心：丙查资料也查不到完整正文 ===');
  const weakToolRes = log.toolResults.filter(x => x.role === 'weak');
  ok(weakToolRes.length >= 1, '丙的请求里确实带了工具结果');
  const weakSaw = weakToolRes.map(x => x.content).join(' ');
  has(weakSaw, '等价无穷小', '丙查到了定义');
  notHas(weakSaw, '乘除因子', '★ 丙查不到「只能用于乘除因子」这句');
  notHas(weakSaw, '1/2', '★ 丙查不到例题');
  ok(weakSaw.length < 200, '丙拿到的资料很短', weakSaw.length);

  console.log('\n=== 9. 甲查资料能查到全部 ===');
  reset(conf);
  const outS = await Classroom.studentTurn('smart', sess, ctx, {});
  const smartSaw = log.toolResults.filter(x => x.role === 'smart').map(x => x.content).join(' ');
  has(smartSaw, '乘除因子', '★ 甲能查到完整正文');
  has(smartSaw, 'relatedPoints', '★ 甲还能看到关联考点');
  ok(smartSaw.length > weakSaw.length, '甲拿到的资料明显比丙多');

  console.log('\n=== 10. recall_mistake 不泄露答案 ===');
  const tctx = (function () {
    const c = Object.create(ctx);
    c.ownMistakes = function (limit) {
      return ctx.mistakeCards().filter(m => m.kid === 'c1n4').slice(0, limit)
        .map(m => ({ stem: m.stem, wrongTimes: m.lapses }));
    };
    return c;
  })();
  const rec = Tools.execute('recall_mistake', { limit: 3 }, tctx);
  ok(rec.ok, 'recall_mistake 执行成功');
  eq(rec.data.mistakes[0].wrongTimes, 3, '带上了错题次数');
  eq(rec.data.mistakes[0].answer, undefined, '★ 没有把正确答案喂给学生');

  console.log('\n=== 11. raise_hand / pass ===');
  const rh = Tools.execute('raise_hand', { question: '为什么要小心加减？' }, ctx);
  ok(rh.ok && rh.data.raised, 'raise_hand 返回 raised');
  eq(rh.data.question, '为什么要小心加减？', '问题被带回');
  const ps = Tools.execute('pass', {}, ctx);
  ok(ps.ok && ps.data.passed, 'pass 返回 passed');

  console.log('\n=== 12. 记忆：只记自己的，且吸收老师点评 ===');
  const memSess = { memory: {} };
  Classroom.updateMemory(memSess, 'weak', '我觉得是 0 吧');
  Classroom.updateMemory(memSess, 'weak', '我觉得是 0 吧');
  eq(memSess.memory.weak.length, 1, '重复的话不重复记');
  eq(memSess.memory.smart, undefined, '没动别人的记忆');
  Classroom.absorbTeacherCorrection(memSess, '学生丙把等价代换当成了约分，这是典型混淆。学生甲说得对。');
  has(memSess.memory.weak.join(' '), '老师点评到我', '★ 丙记住了被点名');
  has(memSess.memory.smart.join(' '), '老师点评到我', '★ 甲也记住了被点名');

  console.log('\n=== 13. 端到端：讨论模式 ===');
  studentTools = false;
  directorQueue = ['weak', 'END'];
  const dbg = { kid: 'c1n4', mode: 'debate', question: QS.c1n4[0], reason: '测试', steps: 2, turns: [], spoken: [], userTurns: [], board: [], memory: {}, profile: '测试学情' };
  reset(conf);
  const events = [];
  await Classroom.run(dbg, ctx, { onEvent: (e) => events.push(e), onStatus: () => { } });
  eq(dbg.stage, 'done', '跑完了');
  eq(dbg.turns[0].role, 'teacher', '老师先抛题');
  eq(dbg.turns[dbg.turns.length - 1].role, 'teacher', '老师最后点评');
  const stuTurns = dbg.turns.filter(t => t.role !== 'teacher');
  ok(stuTurns.length >= 4, '学生至少说了 4 次（首轮 3 + 调度器 1）', stuTurns.length);
  ok(Classroom.STUDENT_KEYS.every(k => dbg.spoken.some(s => s.role === k)), '★ 三个学生都开过口');
  ok(events.some(e => e.type === 'thinking'), '发出了"三人同时在读题"事件');
  ok(log.calls.filter(c => c.startsWith('student:')).length >= 4, '★ 学生是多次独立调用，不是一次批量生成');
  ok(log.calls.includes('director'), '调度器被调用过');

  console.log('\n=== 14. 端到端：课堂模式（老师分步讲）===');
  studentTools = false;
  directorQueue = ['END'];
  const les = { kid: 'c1n4', mode: 'lesson', question: QS.c1n4[0], reason: '测试', steps: 2, turns: [], spoken: [], userTurns: [], board: [], memory: {}, profile: '测试学情' };
  reset(conf);
  await Classroom.run(les, ctx, { onEvent: () => { }, onStatus: () => { } });
  eq(les.stage, 'done', '课堂跑完');
  const teacherTurns = les.turns.filter(t => t.role === 'teacher');
  ok(teacherTurns.length >= 3, '★ 老师至少讲了 3 次（2 步 + 小结）', teacherTurns.length);
  has(teacherTurns[0].text, '这一步', '老师讲的是知识点不是题目');
  ok(les.spoken.length >= 3, '学生也参与了讨论', les.spoken.length);

  console.log('\n=== 15. 老师发言是流式的 ===');
  let deltaSeen = false;
  const les2 = { kid: 'c1n4', mode: 'lesson', question: QS.c1n4[0], steps: 1, turns: [], spoken: [], board: [], memory: {}, profile: '' };
  studentTools = false;
  directorQueue = ['END'];
  await Classroom.run(les2, ctx, {
    onEvent: () => { },
    onDelta: () => { deltaSeen = true; }
  });
  ok(deltaSeen, '★ 收到了流式增量回调');

  server.close();
  console.log('\n──────────────────────────────');
  console.log((fail === 0 ? '✅ 多智能体课堂全部通过：' : '❌ 有失败：') + pass + ' 项' + (fail ? '，失败 ' + fail : ''));
  process.exit(fail ? 1 : 0);
})();
