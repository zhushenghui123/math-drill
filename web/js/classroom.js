/* 研数 · 多智能体课堂（零依赖）
 *
 * 一个老师 + 三个学生，四个都是**真 agent**：各自独立调用模型、各自有记忆、
 * 各自有工具。不再是"一次调用生成四个人的台词"的剧本。
 *
 * ── 三种角色差异，全靠机制而非形容词 ──────────────────────────────
 *  1) 资料可见性递减（levelMaterial）
 *       甲 level 2：正文 + 例题 + 关联考点
 *       乙 level 1：正文 + 例题
 *       丙 level 0：只有第一句定义
 *     关键是：丙调 look_up 工具去查，也只能查到那一句 —— 结构性无知。
 *  2) 错误来源真实（misconceptions）
 *     丙犯的错从题库干扰项和错题记录里挖，不是模型随机编。
 *  3) 发言由调度器决定（schedule）
 *     借鉴 OpenMAIC 的 director graph：本地规则兜底 + 模型决定歧义回合。
 *     能出现"老师点名丙""甲抢话反驳乙"，也能在讨论够了时收束。
 *
 * ── 成本控制 ──────────────────────────────────────────────────
 *  · 第一轮三个学生**并发**（互不影响），墙钟时间等于一次调用
 *  · 第二轮回合起才串行（要看到别人的话）
 *  · 调度器只在歧义回合才调，且有本地规则短路
 *  · 学生 agent loop 上限 2 步，多数回合只有 1 次调用
 */
window.Classroom = (function () {
  'use strict';

  /* ==================================================================
   * 1. 角色
   * ================================================================== */

  var AGENTS = {
    teacher: {
      key: 'teacher', name: '老师', avatar: '师', tag: '主讲',
      role: 'teacher', priority: 100, level: 3
    },
    smart: {
      key: 'smart', name: '学生甲', avatar: '甲', tag: '思路快',
      role: 'student', priority: 60, level: 2,
      voice: [
        '你说话很短，一般 1-2 句，从不铺垫。',
        '你喜欢用一句话把规律概括掉（「其实就是一个……」「这类题统一都……」）。',
        '你觉得基础概念是显然的，所以从不解释它们——这会让基础差的同学跟不上。',
        '你偶尔会不耐烦（「这不就是……吗」），但不是恶意的。'
      ].join('\n')
    },
    average: {
      key: 'average', name: '学生乙', avatar: '乙', tag: '跟得上',
      role: 'student', priority: 40, level: 1,
      voice: [
        '你会先用自己的话复述一遍理解，再提问（「你的意思是不是……？那为什么……」）。',
        '你总想知道「为什么」，会追着前提条件问（「这个只能在 x 趋于 0 的时候用吧？」）。',
        '你做题没问题，但说不清原理，所以对"为什么成立"特别在意。',
        '你说话长度中等，2-3 句。'
      ].join('\n')
    },
    weak: {
      key: 'weak', name: '学生丙', avatar: '丙', tag: '基础弱',
      role: 'student', priority: 20, level: 0,
      voice: [
        '你经常先给一个结论，然后自己也不确定（「……吧？」「应该是这样？」）。',
        '你会把两个概念混在一起，用错术语，而且说得挺自信。',
        '不懂的时候你会硬编一个听起来有道理的理由，而不是承认不会。',
        '你说话口语化，句子短，偶尔跑题。你真心想搞懂，只是底子差。'
      ].join('\n')
    },
    me: { key: 'me', name: '你', avatar: '你', tag: '本人', role: 'me' }
  };

  var STUDENT_KEYS = ['smart', 'average', 'weak'];

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ==================================================================
   * 2. 资料按水平裁剪 —— 差异化的根
   * ================================================================== */

  /* 取第一句话（定义句），丙能看到的全部 */
  function firstSentence(text) {
    var t = String(text || '').trim();
    if (!t) return '';
    for (var i = 0; i < t.length; i++) {
      var ch = t.charAt(i);
      if (ch === '。' || ch === '\n') return t.slice(0, i + 1).trim();
    }
    return t;
  }

  function levelMaterial(ctx, kid, level) {
    var n = (ctx && ctx.node && ctx.node(kid)) || {};
    var out = { title: n.title || kid };
    if (level <= 0) {
      out.definition = firstSentence(n.content || '');
      out.note = '你只记得这一句，其余的全忘了。';
      return out;
    }
    out.content = String(n.content || '');
    out.example = String(n.example || '');
    if (level >= 2) {
      var rel = (n.related || []).map(function (id) {
        var r = ctx.node(id);
        return r ? r.title : id;
      });
      if (rel.length) out.relatedPoints = rel;
      out.note = '你掌握这个考点的完整内容，还知道它和哪些考点关联。';
    } else {
      out.note = '你学过正文和例题，但没系统梳理过它和其他考点的关系。';
    }
    return out;
  }

  /* ==================================================================
   * 3. 选题（纯本地计算，不花模型调用）
   * ================================================================== */

  function findQuestion(ctx, kid, qid) {
    var qs = ctx.questionsOf(kid) || [];
    for (var i = 0; i < qs.length; i++) { if (qs[i].id === qid) return qs[i]; }
    return null;
  }

  function pickTopic(ctx, kid) {
    var mistakes = ctx.mistakeCards();
    if (kid) {
      var own = mistakes.filter(function (m) { return m.kid === kid; });
      if (own.length) mistakes = own;
    }
    mistakes = mistakes.slice().sort(function (a, b) { return (b.lapses || 0) - (a.lapses || 0); });

    for (var i = 0; i < mistakes.length; i++) {
      var q = findQuestion(ctx, mistakes[i].kid, mistakes[i].qid);
      if (q) {
        return {
          kid: mistakes[i].kid, title: mistakes[i].title, question: q,
          reason: '这道题你错过 ' + (mistakes[i].lapses || 1) + ' 次', source: 'mistake'
        };
      }
    }

    var weak = ctx.weakNodes(6);
    for (var j = 0; j < weak.length; j++) {
      var qs = ctx.questionsOf(weak[j].kid);
      if (qs.length) {
        return {
          kid: weak[j].kid, title: weak[j].title,
          question: qs[Math.floor(Math.random() * qs.length)],
          reason: '这个考点你的正确率只有 ' + weak[j].accuracy + '%', source: 'weak'
        };
      }
    }

    var pool = ctx.questionsOf(kid);
    if (pool.length) {
      return {
        kid: kid, title: (ctx.node(kid) || {}).title || kid,
        question: pool[Math.floor(Math.random() * pool.length)],
        reason: '这个考点值得掰扯一下', source: 'current'
      };
    }
    return null;
  }

  function misconceptions(ctx, topic) {
    var out = [];
    var q = topic && topic.question;
    if (!q) return out;

    if (q.type === 'choice' && q.options && q.options.length) {
      var wrong = q.options.filter(function (o) { return o.k !== q.answer; });
      if (wrong.length) {
        out.push('这道题的干扰项（都是真实的错误思路）：' +
          wrong.map(function (o) { return o.k + '. $' + o.t + '$'; }).join('、') +
          '。正确答案是 ' + q.answer + '。');
      }
    }
    if (q.analysis) out.push('标准解析点出的关键：' + q.analysis);

    var ms = ctx.mistakeCards().filter(function (m) { return m.kid === topic.kid; });
    if (ms.length > 1) out.push('这名学生在这个考点上累计错了 ' + ms.length + ' 道题，不是偶然。');
    return out;
  }

  /* ==================================================================
   * 4. prompt 构建
   * ================================================================== */

  function transcript(session, limit) {
    var t = session.turns || [];
    var recent = limit && t.length > limit ? t.slice(t.length - limit) : t;
    return recent.map(function (x) {
      var a = AGENTS[x.role] || { name: x.role };
      var extra = x.note ? '（' + x.note + '）' : '';
      return a.name + '：' + x.text + extra;
    }).join('\n');
  }

  /* ---------- 学生 agent 的 system ---------- */
  function buildStudentSystem(roleKey, session, ctx) {
    var a = AGENTS[roleKey];
    var mat = levelMaterial(ctx, session.kid, a.level);
    var n = ctx.node(session.kid) || {};

    var blocks = [];
    blocks.push('你正在扮演考研数学学习小组里的一个学生。**你不是助手，是学生。**' +
      '你只代表你自己说话，不替老师讲课，不总结全组观点，不写完整解题步骤。');

    blocks.push('【你是谁】\n你是' + a.name + '。\n' + a.voice);

    blocks.push('【你现在记得的内容】\n' + JSON.stringify(mat, null, 2) +
      '\n\n这是你的知识边界，**不要说出这里没有的内容**。你想不起来就去调 look_up 工具查，' +
      '但查到的也只有上面这些——你的水平决定了你能查到多少。');

    if (a.level <= 0) {
      var misc = misconceptions(ctx, { kid: session.kid, question: session.question });
      if (misc.length) {
        blocks.push('【你容易踩的坑】\n' + misc.map(function (m) { return '- ' + m; }).join('\n') +
          '\n\n你可以自然地掉进这些坑里，但要**错得有推理过程**，不是乱说。');
      }
    }

    blocks.push([
      '【你可以调用的工具】',
      '- look_up：翻书查这个考点（只能查到上面那些）',
      '- recall_mistake：回忆你自己在这个考点上做错过的题',
      '- draw_graph：在黑板上画函数图像（讲不清时画出来很有效）',
      '- raise_hand：有个实在绕不过去的问题，举手问老师（本轮结束）',
      '- pass：这轮没什么想说的（别滥用）',
      '',
      '不需要工具就直接说话。工具是为你的发言服务的，不是必须走的流程。'
    ].join('\n'));

    blocks.push([
      '【硬性要求】',
      '1. 用**你自己的水平**说话。' + (a.level <= 0
        ? '你可以说得不准确、可以混淆概念——这是你的角色设定，不要突然变聪明。'
        : a.level >= 2
          ? '你说话简短犀利，但不要替别人把话说完。'
          : '你可以提问，但不要替老师给完整解答。'),
      '2. 1-3 句话，口语化，像微信群里聊天。禁止客套话（「说得好」「有道理」「感谢分享」）。',
      '3. 如果前面有人说过话，你要**接住他的话**（「你刚才说……」「不对吧，那……」），不要自说自话。',
      '4. 数学公式用 LaTeX：行内 $...$。',
      '5. 禁止出现「作为 AI」「作为一个语言模型」这类表述。',
      '6. 你的发言内容就是你要说的话本身，不要加「学生甲：」这样的前缀，不要输出 JSON。'
    ].join('\n'));

    return blocks.join('\n\n');
  }

  function buildStudentUser(roleKey, session, ctx) {
    var a = AGENTS[roleKey];
    var mem = (session.memory && session.memory[roleKey]) || [];
    var parts = [];

    parts.push('【正在学的考点】' + ((ctx.node(session.kid) || {}).title || session.kid));
    if (session.mode === 'debate' && session.question) {
      var q = session.question;
      var qt = String(q.stem || '');
      if (q.type === 'choice' && q.options) {
        qt += '\n' + q.options.map(function (o) { return o.k + '. $' + o.t + '$'; }).join('\n');
      }
      parts.push('【讨论的题目】\n' + qt);
    }

    parts.push('【到目前为止发生了什么】\n' + (transcript(session, 10) || '（还没人说话）'));

    if (mem.length) {
      parts.push('【你自己之前说过 / 被纠正过的】\n' + mem.map(function (m) { return '- ' + m; }).join('\n'));
    }
    if (session.pendingHand && session.pendingHand.role === roleKey) {
      parts.push('【你刚才举手问的是】' + session.pendingHand.question + '\n老师已经回答过了，你可以接着说你的理解。');
    }

    parts.push('现在轮到你（' + a.name + '）说话。用你自己的水平说 1-3 句。');
    return parts.join('\n\n');
  }

  /* ---------- 老师的 system ---------- */
  function buildTeacherSystem(session, ctx, phase) {
    var n = ctx.node(session.kid) || {};
    var a = AGENTS.teacher;
    var parts = [];

    parts.push('你是一位考研数学老师，正在带一个小班：一个学生（用户本人）和三个旁听学生（甲、乙、丙）。' +
      '甲反应快，乙爱追问，丙基础薄弱——你在讲解时要照顾到丙，但不要点破"你基础差"。');

    parts.push('【本考点正文（你的知识依据，不要讲错）】\n' + String(n.content || '') +
      (n.example ? '\n\n例题：' + n.example : '') +
      '\n\n**只依据上面的内容讲，不确定的地方不要编。**');

    parts.push('【这名学生的学情】\n' + (session.profile || '（暂无记录）'));

    if (phase === 'open') {
      parts.push([
        '【你的任务：抛出讨论题】',
        '用 2-4 句话说清这道题为什么值得讨论（点出它对应的考点、以及大家容易在哪翻车），然后提问。',
        '不要给答案，不要给解题步骤。'
      ].join('\n'));
    } else if (phase === 'teach') {
      parts.push([
        '【你的任务：讲解第 ' + ((session.stepIndex || 0) + 1) + ' 步，共 ' + session.steps + ' 步】',
        '只讲这一步，150-250 字。讲完在最后抛**一个**具体的小问题给三个学生（不是"大家明白了吗"这种空问题）。',
        '不要一次把所有内容讲完——后面还有步骤。'
      ].join('\n'));
    } else if (phase === 'answer') {
      parts.push([
        '【你的任务：答疑】',
        '有学生举手了（见下）。先直接回答他的问题，再把它挂回当前知识点。',
        '如果他的问题暴露了典型误解，顺手指出来，但别打击人。150-250 字。'
      ].join('\n'));
    } else if (phase === 'comment') {
      parts.push([
        '【你的任务：课后点评】',
        '必须包含三部分：',
        '1. **点名点评** —— 甲、乙、丙谁说得对、谁错在哪一步。直接点名，不要笼统说"大家"。',
        '2. **补漏** —— 讨论里没讲透的关键点，你补上。',
        '3. **必记结论** —— 收敛成 2-3 条考场上能直接用的结论。',
        '250-400 字。不要重复学生已经说清楚的内容。'
      ].join('\n'));
    } else {
      parts.push([
        '【你的任务：收尾小结】',
        '把这一节课的内容收敛成 2-3 条必记结论，并指出丙这类同学最容易在哪一步出错。200-350 字。'
      ].join('\n'));
    }

    parts.push('【格式】Markdown，公式用 LaTeX。语气像老师随口讲，不要写成论文，不要用"首先/其次/最后"这种模板腔。');
    return parts.join('\n\n');
  }

  function buildTeacherUser(session, ctx, phase) {
    var parts = [];
    parts.push('【到目前为止的课堂记录】\n' + (transcript(session, 14) || '（刚开始）'));

    if (phase === 'answer' && session.pendingHand) {
      parts.push('【举手的是】' + AGENTS[session.pendingHand.role].name +
        '\n【他问的是】' + session.pendingHand.question);
    }
    if (session.userTurns && session.userTurns.length) {
      parts.push('【学生本人（用户）说过的话】\n' +
        session.userTurns.slice(-3).map(function (u) { return '- ' + u.text; }).join('\n'));
    }
    return parts.join('\n\n');
  }

  /* ---------- 调度器 ---------- */
  function buildDirectorSystem(session) {
    var roster = Object.keys(AGENTS)
      .filter(function (k) { return k !== 'me'; })
      .map(function (k) {
        var a = AGENTS[k];
        return '- id: "' + k + '", name: "' + a.name + '", role: ' + a.role + ', priority: ' + a.priority;
      }).join('\n');

    var spoken = (session.spoken || []).map(function (s) {
      return '- ' + AGENTS[s.role].name + '（' + s.role + '）：' + String(s.text || '').slice(0, 60);
    }).join('\n') || '（本轮还没人说话）';

    return [
      '你是一场考研数学课堂讨论的**调度器**。你不参与讨论，只决定下一个该谁发言。',
      '',
      '【可选的人】',
      roster,
      '',
      '【本轮已经发过言的】',
      spoken,
      '',
      '【规则】',
      '1. 老师（teacher）负责讲解、答疑、点评。只有在需要收束、需要澄清、或学生明确问老师时才选老师。',
      '2. 学生之间要有**交锋**：如果某人说了明显有问题的话，优先让另一个人去反驳他，而不是换话题。',
      '3. 避免同一个人连着说两次。',
      '4. 如果这场讨论已经说透了、再聊下去是重复，返回 "END"。',
      '5. 讨论质量优先于轮数——说完了就结束，不要为了凑轮数硬让人发言。',
      '',
      '【输出格式】只输出 JSON，不要任何解释：',
      '{"next": "student_id 或 teacher 或 END", "why": "一句话理由"}'
    ].join('\n');
  }

  function parseDirector(text) {
    var s = String(text || '').trim();
    var m = s.match(/\{[\s\S]*?"next"[\s\S]*?\}/);
    if (!m) return undefined;
    var j;
    try { j = JSON.parse(m[0]); } catch (e) { return undefined; }
    var next = String(j.next || '').trim();
    if (!next) return undefined;
    if (next === 'END' || next === 'end') return null;
    if (next === 'teacher') return 'teacher';
    if (AGENTS[next] && AGENTS[next].role === 'student') return next;
    return undefined;
  }

  /* 本地规则：能一眼定的就别花调用。返回 roleKey / null(结束) / undefined(交给模型) */
  function localSchedule(session) {
    if (session.pendingHand) return 'teacher';

    var spoken = session.spoken || [];
    var minTurns = session.minTurns || 3;
    var maxTurns = session.maxTurns || 6;

    // 保证每个学生至少开口一次
    if (spoken.length < minTurns) {
      var silent = STUDENT_KEYS.filter(function (k) {
        return !spoken.some(function (s) { return s.role === k; });
      });
      if (silent.length) {
        silent.sort(function (a, b) { return AGENTS[b].priority - AGENTS[a].priority; });
        return silent[0];
      }
    }
    if (spoken.length >= maxTurns) return null;
    return undefined;
  }

  function fallbackRotate(session) {
    var spoken = session.spoken || [];
    var last = spoken.length ? spoken[spoken.length - 1].role : null;
    var order = STUDENT_KEYS.slice().sort(function (a, b) { return AGENTS[b].priority - AGENTS[a].priority; });
    for (var i = 0; i < order.length; i++) {
      if (order[i] !== last) return order[i];
    }
    return order[0];
  }

  /* ==================================================================
   * 5. 模型调用（工具参数不被支持时自动降级为文本协议）
   * ================================================================== */

  async function callModel(conf, messages, opts) {
    try {
      return await LLM.chat(conf, messages, opts);
    } catch (e) {
      var msg = String((e && e.message) || '');
      if (opts.tools && /tool|function|unsupported|not support|400|invalid/i.test(msg)) {
        var msgs2 = messages.slice();
        msgs2[0] = {
          role: 'system',
          content: msgs2[0].content + '\n\n' + [
            '【工具调用格式】你需要在正文里用下面的代码块来调用工具：',
            '```tool',
            '{"name": "工具名", "arguments": {...}}',
            '```',
            '不需要工具就直接正常说话。'
          ].join('\n')
        };
        var opts2 = {};
        for (var k in opts) if (opts.hasOwnProperty(k)) opts2[k] = opts[k];
        opts2.tools = null;
        return await LLM.chat(conf, msgs2, opts2);
      }
      throw e;
    }
  }

  /* ==================================================================
   * 6. 一次学生发言（真 agent loop，带工具）
   * ================================================================== */

  var STUDENT_MAX_STEPS = 2;

  /* 学生的工具必须跑在一个"被裁剪过的世界"里：
     look_up 只能查到该生水平允许的内容，recall_mistake 只能看到题面和错次，
     绝不能把正确答案喂给学生。 */
  function studentToolCtx(ctx, roleKey, session) {
    var t = Object.create(ctx);
    t.levelMaterial = function () { return levelMaterial(ctx, session.kid, AGENTS[roleKey].level); };
    t.ownMistakes = function (limit) {
      return ctx.mistakeCards()
        .filter(function (m) { return m.kid === session.kid; })
        .slice(0, limit || 3)
        .map(function (m) { return { stem: m.stem, wrongTimes: m.lapses }; });
    };
    return t;
  }

  async function studentTurn(roleKey, session, ctx, hooks) {
    hooks = hooks || {};
    if (hooks.onTurnStart) hooks.onTurnStart(roleKey);
    var conf = ctx.llmConf();
    if (!conf) throw new Error('未配置模型');
    var toolCtx = studentToolCtx(ctx, roleKey, session);

    var messages = [
      { role: 'system', content: buildStudentSystem(roleKey, session, ctx) },
      { role: 'user', content: buildStudentUser(roleKey, session, ctx) }
    ];

    var usedTools = [];
    var boardItems = [];
    var hand = null;
    var passed = false;
    var finalText = '';

    for (var step = 0; step < STUDENT_MAX_STEPS; step++) {
      var res = await callModel(conf, messages, {
        tools: Tools.STUDENT_SCHEMA,
        stream: false,
        temperature: 0.85,
        maxTokens: 400
      });

      var calls = res.toolCalls || [];
      if (!calls.length) { finalText = String(res.content || '').trim(); break; }

      // 回灌助手消息（含 tool_calls），再逐条回工具结果
      messages.push({
        role: 'assistant',
        content: res.content || '',
        tool_calls: calls.map(function (c) {
          return {
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args || {}) }
          };
        })
      });

      for (var i = 0; i < calls.length; i++) {
        var c = calls[i];
        var r = Tools.execute(c.name, c.args, toolCtx);
        usedTools.push({ name: c.name, args: c.args, ok: r.ok, data: r.data });

        if (c.name === 'raise_hand' && r.ok) {
          hand = String((c.args && c.args.question) || (r.data && r.data.question) || '').trim() || '我有点没跟上，能再讲一遍吗？';
        }
        if (c.name === 'pass' && r.ok) passed = true;
        if (c.name === 'draw_graph' && r.ok && r.render && r.render.html) {
          boardItems.push({ by: roleKey, kind: 'graph', expr: (r.data && r.data.expr) || '', svg: r.render.html });
        }

        messages.push({
          role: 'tool',
          tool_call_id: c.id,
          content: JSON.stringify(r.ok ? r.data : { error: r.error })
        });
      }

      if (hand || passed) break;   // 举手 / 弃权都是终结动作
    }

    if (!finalText && !passed && !hand) finalText = '……我还没想好。';
    if (hand && !finalText) finalText = hand;

    return { role: roleKey, text: finalText, tools: usedTools, board: boardItems, hand: hand, passed: passed };
  }

  /* ==================================================================
   * 7. 老师发言（流式）
   * ================================================================== */

  async function teacherTurn(session, ctx, phase, hooks) {
    hooks = hooks || {};
    if (hooks.onTurnStart) hooks.onTurnStart('teacher');
    var conf = ctx.llmConf();
    if (!conf) throw new Error('未配置模型');

    var messages = [
      { role: 'system', content: buildTeacherSystem(session, ctx, phase) },
      { role: 'user', content: buildTeacherUser(session, ctx, phase) }
    ];

    var res = await callModel(conf, messages, {
      stream: true,
      temperature: 0.5,
      maxTokens: 900,
      onDelta: function (d, full) { if (hooks.onDelta) hooks.onDelta('teacher', full); }
    });

    var text = String(res.content || '').trim();
    var item = { role: 'teacher', text: text, phase: phase };
    session.turns.push(item);
    session.lastTeacherText = text;
    if (hooks.onEvent) hooks.onEvent({ type: 'say', item: item });
    return item;
  }

  /* ==================================================================
   * 8. 记忆：每个学生只记自己的
   * ================================================================== */

  function updateMemory(session, roleKey, text) {
    if (!session.memory) session.memory = {};
    if (!session.memory[roleKey]) session.memory[roleKey] = [];
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (t.length > 90) t = t.slice(0, 90) + '…';
    var arr = session.memory[roleKey];
    if (arr.length && arr[arr.length - 1] === '我说过：' + t) return;
    arr.push('我说过：' + t);
    if (arr.length > 4) arr.shift();
  }

  /* 老师点了谁的名，就把那句话记到那个学生头上 —— 这是"被纠正"的记忆 */
  function absorbTeacherCorrection(session, text) {
    if (!text) return;
    var sentences = String(text).split(/[。！？\n]/).filter(Boolean);
    STUDENT_KEYS.forEach(function (k) {
      var name = AGENTS[k].name;
      var hit = sentences.filter(function (s) { return s.indexOf(name) >= 0; });
      if (!hit.length) return;
      if (!session.memory) session.memory = {};
      if (!session.memory[k]) session.memory[k] = [];
      var s = hit[0].replace(/\s+/g, ' ').trim();
      if (s.length > 90) s = s.slice(0, 90) + '…';
      var rec = '老师点评到我：' + s;
      if (session.memory[k].indexOf(rec) < 0) {
        session.memory[k].push(rec);
        if (session.memory[k].length > 4) session.memory[k].shift();
      }
    });
  }

  /* ==================================================================
   * 9. 调度
   * ================================================================== */

  async function directorCall(session, ctx) {
    var conf = ctx.llmConf();
    var res = await callModel(conf, [
      { role: 'system', content: buildDirectorSystem(session) },
      { role: 'user', content: '下一个该谁发言？只输出 JSON。' }
    ], { stream: false, temperature: 0.3, maxTokens: 80 });
    return parseDirector(res.content);
  }

  async function schedule(session, ctx) {
    var local = localSchedule(session);
    if (local !== undefined) return local;
    try {
      var d = await directorCall(session, ctx);
      if (d !== undefined) return d;
    } catch (e) { /* 调度器不可用就退回轮转，不能让整节课挂掉 */ }
    return fallbackRotate(session);
  }

  /* ==================================================================
   * 10. 主流程
   * ================================================================== */

  function record(session, roleKey, text, extra) {
    var item = { role: roleKey, text: text };
    if (extra && extra.note) item.note = extra.note;
    session.turns.push(item);
    if (roleKey !== 'teacher' && roleKey !== 'me') {
      session.spoken.push(item);
      updateMemory(session, roleKey, text);
    }
    return item;
  }

  function emit(hooks, ev) { if (hooks.onEvent) hooks.onEvent(ev); }
  function status(hooks, s) { if (hooks.onStatus) hooks.onStatus(s); }

  /* 一轮讨论：调度器驱动，串行 */
  async function discussLoop(session, ctx, hooks, quota) {
    var start = (session.spoken || []).length;
    session.maxTurns = start + quota;
    if (!session.minTurns) session.minTurns = start + Math.min(3, quota);

    var guard = 0;
    while (guard++ < 24) {
      var next = await schedule(session, ctx);
      if (!next) break;

      if (next === 'teacher') {
        status(hooks, '老师答疑中');
        await teacherTurn(session, ctx, 'answer', hooks);
        absorbTeacherCorrection(session, session.lastTeacherText);
        session.pendingHand = null;
        continue;
      }

      status(hooks, AGENTS[next].name + ' 正在想…');
      var out;
      try {
        out = await studentTurn(next, session, ctx, hooks);
      } catch (e) {
        emit(hooks, { type: 'error', role: next, message: String((e && e.message) || e) });
        session.spoken.push({ role: next, text: '（掉线了）' });
        continue;
      }

      if (out.passed && !out.text) {
        emit(hooks, { type: 'pass', role: next });
        session.spoken.push({ role: next, text: '' });
        continue;
      }

      var item = record(session, next, out.text);
      if (out.hand) {
        session.pendingHand = { role: next, question: out.hand };
        item.note = '举手';
      }
      emit(hooks, { type: 'say', item: item, tools: out.tools, board: out.board });

      for (var b = 0; b < (out.board || []).length; b++) {
        session.board.push(out.board[b]);
        emit(hooks, { type: 'board', item: out.board[b] });
      }
      if (out.board && out.board.length) {
        emit(hooks, { type: 'status', text: AGENTS[next].name + ' 在黑板上画了图' });
      }
    }
  }

  /* 第一轮并发：三个学生互不影响，一起发请求 */
  async function parallelFirstRound(session, ctx, hooks) {
    emit(hooks, { type: 'thinking', roles: STUDENT_KEYS.slice() });
    status(hooks, '三个学生同时在读题…');

    var results = await Promise.all(STUDENT_KEYS.map(function (k) {
      return studentTurn(k, session, ctx, {}).catch(function (e) {
        return { role: k, text: '（掉线了：' + String((e && e.message) || e).slice(0, 40) + '）', tools: [], board: [] };
      });
    }));

    emit(hooks, { type: 'thinking-done' });

    for (var i = 0; i < results.length; i++) {
      var out = results[i];
      if (out.passed && !out.text) { emit(hooks, { type: 'pass', role: out.role }); session.spoken.push({ role: out.role, text: '' }); continue; }
      var item = record(session, out.role, out.text);
      if (out.hand) { session.pendingHand = { role: out.role, question: out.hand }; item.note = '举手'; }
      emit(hooks, { type: 'say', item: item, tools: out.tools, board: out.board });
      for (var b = 0; b < (out.board || []).length; b++) {
        session.board.push(out.board[b]);
        emit(hooks, { type: 'board', item: out.board[b] });
      }
      await sleep(260);
    }
  }

  /* 学生本人插话 → 老师当场回应 */
  async function replyToUser(session, userText, ctx, hooks) {
    hooks = hooks || {};
    var conf = ctx.llmConf();
    if (!conf) throw new Error('未配置模型');
    session.userTurns = session.userTurns || [];
    session.userTurns.push({ text: userText, ts: Date.now() });
    session.turns.push({ role: 'me', text: userText });

    var messages = [
      { role: 'system', content: buildTeacherSystem(session, ctx, 'answer') },
      { role: 'user', content: [
        '【到目前为止的课堂记录】\n' + (transcript(session, 14) || '（刚开始）'),
        '【学生本人（用户）刚刚说】\n' + userText,
        '【任务】先直接回应他 —— 对就肯定并补一句为什么对，错就指出错在哪一步。' +
        '如果他把话题带偏了，温和地拉回来。150-250 字，Markdown，公式用 LaTeX。不要重复三个旁听学生已经说过的。'
      ].join('\n\n') }
    ];

    var res = await callModel(conf, messages, {
      stream: true, temperature: 0.5, maxTokens: 700,
      onDelta: function (d, full) { if (hooks.onDelta) hooks.onDelta('teacher', full); }
    });
    var text = String(res.content || '').trim();
    session.turns.push({ role: 'teacher', text: text, phase: 'answer' });
    if (hooks.onEvent) hooks.onEvent({ type: 'say', item: { role: 'teacher', text: text } });
    return text;
  }

  /* ---------- 课堂模式：老师分步讲，每步之后学生讨论 ---------- */
  async function runLesson(session, ctx, hooks) {
    var steps = session.steps || 2;
    for (var i = 0; i < steps; i++) {
      session.stepIndex = i;
      status(hooks, '老师讲解第 ' + (i + 1) + ' / ' + steps + ' 步');
      await teacherTurn(session, ctx, 'teach', hooks);
      if (i === 0) {
        await parallelFirstRound(session, ctx, hooks);
      } else {
        await discussLoop(session, ctx, hooks, 3);
      }
    }
    status(hooks, '老师小结');
    await teacherTurn(session, ctx, 'wrap', hooks);
    absorbTeacherCorrection(session, session.lastTeacherText);
  }

  /* ---------- 讨论模式：老师抛题，学生互怼，老师点评 ---------- */
  async function runDebate(session, ctx, hooks) {
    status(hooks, '老师抛题');
    await teacherTurn(session, ctx, 'open', hooks);
    await parallelFirstRound(session, ctx, hooks);
    await discussLoop(session, ctx, hooks, 4);
    status(hooks, '老师点评');
    await teacherTurn(session, ctx, 'comment', hooks);
    absorbTeacherCorrection(session, session.lastTeacherText);
  }

  async function run(session, ctx, hooks) {
    hooks = hooks || {};
    var conf = ctx.llmConf();
    if (!conf) throw new Error('未配置模型，课堂模式需要真实 AI');

    if (!session.memory) session.memory = {};
    if (!session.spoken) session.spoken = [];
    if (!session.turns) session.turns = [];
    if (!session.board) session.board = [];

    session.stage = 'running';
    try {
      if (session.mode === 'lesson') await runLesson(session, ctx, hooks);
      else await runDebate(session, ctx, hooks);
      session.stage = 'done';
      session.ts = Date.now();
      emit(hooks, { type: 'done' });
      return session;
    } catch (e) {
      session.stage = 'failed';
      session.error = String((e && e.message) || e);
      emit(hooks, { type: 'error', message: session.error });
      throw e;
    }
  }

  return {
    AGENTS: AGENTS,
    STUDENT_KEYS: STUDENT_KEYS,
    STUDENT_MAX_STEPS: STUDENT_MAX_STEPS,

    firstSentence: firstSentence,
    levelMaterial: levelMaterial,
    pickTopic: pickTopic,
    misconceptions: misconceptions,

    buildStudentSystem: buildStudentSystem,
    buildStudentUser: buildStudentUser,
    buildTeacherSystem: buildTeacherSystem,
    buildDirectorSystem: buildDirectorSystem,
    transcript: transcript,

    parseDirector: parseDirector,
    localSchedule: localSchedule,
    fallbackRotate: fallbackRotate,
    schedule: schedule,

    studentTurn: studentTurn,
    teacherTurn: teacherTurn,
    replyToUser: replyToUser,
    updateMemory: updateMemory,
    absorbTeacherCorrection: absorbTeacherCorrection,

    run: run,
    runLesson: runLesson,
    runDebate: runDebate,
    parallelFirstRound: parallelFirstRound,
    discussLoop: discussLoop,

    sleep: sleep
  };
})();
