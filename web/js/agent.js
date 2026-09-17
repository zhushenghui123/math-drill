/* 研数 · Agent 内核（零依赖）
 *
 * 把"关键词路由 + 写死模板"换成真正的 agent loop：
 *   学生说一句话 → 模型带着【实时学情】和【工具清单】思考 → 自主调工具取真实数据
 *   → 拿到结果继续推理 → 直到给出最终回答。
 *
 * 借鉴自 Pi 的三个机制：
 *   1) agent loop + tool calling —— 模型有手有眼，不再是纯文本复读机
 *   2) SYSTEM.md 可替换人设 —— 同一个内核，四种老师风格
 *   3) compaction —— 长对话压成摘要，不爆上下文
 */
window.Agent = (function () {
  'use strict';

  var MAX_STEPS = 6;

  /* 老师人设：对应 Pi 的 SYSTEM.md —— 换的不是功能，是同一个内核的语气与策略 */
  var PERSONAS = {
    strict: {
      name: '严格督学',
      desc: '不留情面，答错就指出，拒绝含糊过去',
      prompt: [
        '你的风格：严格督学。',
        '- 学生答错时直接指出错在哪一步，不要用"没关系""很棒"这类安慰话打头。',
        '- 学生说"大概懂了吧""差不多"时，不接受，要求他用一句话复述关键步骤。',
        '- 每次只夸具体的行为（"这一步放缩选得对"），不夸人。',
        '- 该重做就让他重做，不因为赶进度放水。'
      ].join('\n')
    },
    humor: {
      name: '段子手',
      desc: '把定理讲成段子，用生活场景做类比',
      prompt: [
        '你的风格：段子手。',
        '- 每个抽象概念都配一个生活化类比或冷幽默，让学生记住"感觉"再记定义。',
        '- 允许开玩笑，但笑点必须服务于理解，不能跑题。',
        '- 例如讲夹逼准则可以用"两个胖子把一个瘦子夹在中间，瘦子只能跟着走"。',
        '- 讲完段子立刻回到严谨表述，别只留下段子。'
      ].join('\n')
    },
    socratic: {
      name: '苏格拉底',
      desc: '只反问，不给答案，逼学生自己推出来',
      prompt: [
        '你的风格：苏格拉底式提问。',
        '- 默认不给结论，先反问一个更小的问题，让学生自己迈出下一步。',
        '- 每次只问一个问题，等学生回答后再问下一个。',
        '- 学生卡住时，把问题拆得更小，而不是直接给答案。',
        '- 只有当学生连续两次卡在同一处、或明确说"直接告诉我"时，才给出完整讲解。'
      ].join('\n')
    },
    exam: {
      name: '应试机器',
      desc: '只讲考法、得分点、秒杀技巧，不谈来龙去脉',
      prompt: [
        '你的风格：应试机器。',
        '- 一切围绕"考场上怎么拿分"：这题属于什么题型、有几种解法、哪种最快。',
        '- 明确标出得分点和扣分点（比如"不写这一步扣 2 分"）。',
        '- 主动总结秒杀技巧和常见陷阱，不展开数学史和直觉铺垫。',
        '- 语言极简，能一句话说完不说两句。'
      ].join('\n')
    }
  };

  /* 文本工具协议：给不支持原生 function calling 的模型（多为本地小模型）兜底 */
  var TEXT_TOOL_PROTOCOL = [
    '',
    '【工具调用格式】',
    '你需要数据时，不要凭空猜测，直接输出一个 tool 代码块来调用工具：',
    '',
    '```tool',
    '{"name": "get_mistakes", "arguments": {"kid": "c1n2", "limit": 5}}',
    '```',
    '',
    '系统会把执行结果发回给你，你据此继续回答。一次只调一个工具，拿到结果再决定下一步。',
    '不需要工具时正常输出文字即可。'
  ].join('\n');

  function pct(v) { return v == null ? '—' : Math.round(v * 100) + '%'; }

  /* ---------------- 学情摘要：这是让 AI "看得见学生"的关键 ----------------
   * 旧版 system prompt 里只有知识点正文，模型完全不知道这个学生错在哪。
   * 这里把 localStorage 里的作答记录、错题本、打卡数据实时算成一段自然语言。
   */
  function learningProfile(ctx, kid) {
    var lines = [];
    var p = ctx.progress();

    lines.push('考试范围：' + (p.trackName || '数学一'));
    if (p.daysLeft != null) lines.push('距目标考试还有 ' + p.daysLeft + ' 天');
    lines.push('考点进度：已掌握 ' + p.mastered + ' 个 / 学习中 ' + p.learning + ' 个 / 未开始 ' + p.untouched + ' 个（共 ' + p.total + ' 个）');
    lines.push('连续打卡：' + p.streak + ' 天');
    if (p.accuracy7d != null) {
      lines.push('近 7 天正确率：' + pct(p.accuracy7d) + '（共作答 ' + p.attempts7d + ' 题）');
    } else {
      lines.push('近 7 天还没有作答记录');
    }

    var weak = ctx.weakNodes(4);
    if (weak.length) {
      lines.push('最薄弱的考点：' + weak.map(function (w) {
        return '「' + w.title + '」正确率 ' + w.accuracy + '%，累计错 ' + w.wrong + ' 次';
      }).join('；'));
    } else if (p.mastered + p.learning === 0) {
      lines.push('这是一名全新学生，还没有任何作答记录 —— 讲解要从最基础处开始，先建立信心。');
    }

    // 当前考点的个人历史
    if (kid) {
      var arr = ctx.attemptsOf(kid);
      var n = ctx.node(kid);
      if (n) {
        if (arr.length) {
          var wrong = arr.filter(function (a) { return !a.correct; }).length;
          var recent = arr.slice(-3).map(function (a) { return a.correct ? '对' : '错'; }).join('');
          lines.push('本考点（' + n.title + '）历史：做过 ' + arr.length + ' 题，错 ' + wrong + ' 题，最近三次作答依次是 ' + recent);
          var ms = ctx.mistakeCards().filter(function (m) { return m.kid === kid; });
          if (ms.length) {
            lines.push('本考点待攻克错题：' + ms.slice(0, 3).map(function (m) {
              return m.qid + '（错 ' + m.lapses + ' 次）';
            }).join('、'));
          }
        } else {
          lines.push('本考点（' + n.title + '）该生此前没有任何作答记录，这是第一次接触。');
        }
      }
    }

    return lines.map(function (l) { return '- ' + l; }).join('\n');
  }

  /* ---------------- system prompt ---------------- */
  function buildSystem(sess, ctx) {
    var n = ctx.node(sess.kid);
    var persona = PERSONAS[(ctx.persona && ctx.persona()) || 'strict'] || PERSONAS.strict;

    var blocks = [];

    blocks.push('你是一位考研数学一对一辅导老师，正在辅导一名备战考研数学的学生。你不是在"回答问题"，你是在"带着他学会"。');

    blocks.push('【学生学情 · 实时数据】\n' + learningProfile(ctx, sess.kid));

    blocks.push(persona.prompt);

    if (n) {
      blocks.push([
        '【当前教学知识点】',
        '标题：' + n.title,
        'id：' + n.id,
        '难度：' + n.difficulty + '/5',
        '适用：' + (n.exam === 'all' ? '数一/数二/数三' : n.exam.join('、')),
        '',
        '正文：',
        String(n.content || ''),
        n.example ? '\n例题：\n' + n.example : ''
      ].join('\n'));
    }

    blocks.push([
      '【你可以调用的工具】',
      '你有一组工具可以读取这名学生的真实数据，也可以直接产出教学内容。',
      '**重要：凡是涉及"这名学生的具体情况"，一律用工具查，不要凭空猜测或编造。**',
      '- query_weakness —— 查他最薄弱的考点',
      '- get_mistakes —— 翻他的错题本（讲评时先看这个）',
      '- pick_question —— 从题库抽题（可指定知识点与难度）',
      '- get_node —— 读某个考点的完整正文与关联考点',
      '- search_nodes —— 按关键词检索考点',
      '- get_progress —— 看整体进度',
      '- draw_graph —— 把函数画成图像直接显示给他（讲极限、单调性、凹凸性、面积时务必用）',
      '- save_note —— 把他的总结记到考点下',
      '- mark_mastered —— 标记该考点已掌握并生成复习卡片'
    ].join('\n'));

    blocks.push([
      '【教学规则】',
      '1. 全程中文，数学公式一律用 LaTeX：行内 $...$，独立公式 $$...$$。',
      '2. 先直觉后严格：先用几何直观或生活例子建立直觉，再给严格定义。',
      '3. **每次回复不超过 250 字**，讲一个点就停下来等反馈，禁止一次性长篇灌输。',
      '4. 主动点明该考点的考研考法：常考题型、易错点、典型陷阱。',
      '5. 学生答错时不要直接甩完整答案，先指出思路断在哪一步，引导他自己补上（除非他说"直接告诉我"）。',
      '6. 验收时一次只出一道题，等他作答后再点评并出下一道。',
      '7. 需要视觉化时果断调用 draw_graph，不要只用文字描述图像。',
      '8. 不知道的定理和公式就承认不知道，**严禁编造**。'
    ].join('\n'));

    return blocks.join('\n\n');
  }

  /* ---------------- compaction：长对话压成摘要 ---------------- */
  function compactHistory(history, keepLast) {
    var h = history || [];
    if (h.length <= keepLast) return h.slice();
    var older = h.slice(0, h.length - keepLast);
    var recent = h.slice(h.length - keepLast);
    var digest = older.map(function (m) {
      var who = m.role === 'user' ? '学生' : '老师';
      var t = String(m.content || '').replace(/\s+/g, ' ').trim();
      if (t.length > 50) t = t.slice(0, 50) + '…';
      return who + '说：' + t;
    }).join(' | ');
    return [{ role: 'assistant', content: '【此前对话摘要（已压缩）】' + digest }].concat(recent);
  }

  /* ---------------- 带降级的调用：模型不认 tools 参数时自动切文本协议 ---------------- */
  async function callModel(conf, messages, opts) {
    try {
      return await LLM.chat(conf, messages, opts);
    } catch (e) {
      var msg = String((e && e.message) || '');
      var looksUnsupported = /tool|function|unsupported|not support|400|invalid/i.test(msg);
      if (opts.tools && looksUnsupported) {
        var msgs2 = messages.slice();
        msgs2[0] = { role: 'system', content: msgs2[0].content + '\n' + TEXT_TOOL_PROTOCOL };
        var opts2 = {};
        for (var k in opts) if (opts.hasOwnProperty(k)) opts2[k] = opts[k];
        opts2.tools = null;
        return await LLM.chat(conf, msgs2, opts2);
      }
      throw e;
    }
  }

  /* ---------------- agent loop ---------------- */
  async function run(sess, userText, ctx, hooks) {
    hooks = hooks || {};
    function noop() {}
    var onAssistantStart = hooks.onAssistantStart || noop;
    var onAssistantDelta = hooks.onAssistantDelta || noop;
    var onAssistantDone = hooks.onAssistantDone || noop;
    var onAssistantDrop = hooks.onAssistantDrop || noop;
    var onToolStart = hooks.onToolStart || noop;
    var onToolEnd = hooks.onToolEnd || noop;

    var conf = ctx.llmConf();
    if (!conf || !conf.base || !conf.model) {
      throw new Error('未配置可用模型');
    }

    var messages = [{ role: 'system', content: buildSystem(sess, ctx) }];
    compactHistory(sess.history, 12).forEach(function (m) {
      messages.push({ role: m.role, content: m.content });
    });
    messages.push({ role: 'user', content: userText });

    var usedTools = [];

    for (var step = 0; step < MAX_STEPS; step++) {
      var bubble = onAssistantStart();
      var res;
      try {
        res = await callModel(conf, messages, {
          tools: Tools.SCHEMA,
          stream: true,
          temperature: 0.4,
          onDelta: function (delta, full) { onAssistantDelta(bubble, full); }
        });
      } catch (e) {
        onAssistantDrop(bubble);
        throw e;
      }

      var text = String(res.content || '').trim();
      var calls = res.toolCalls || [];

      if (text) {
        onAssistantDone(bubble, res.content);
      } else {
        onAssistantDrop(bubble);
      }

      // 没有工具调用 → 这就是最终回答
      if (!calls.length) {
        if (!text) throw new Error('模型返回了空内容，请检查模型是否正常工作');
        return { content: res.content, usedTools: usedTools, steps: step + 1 };
      }

      // 把这一轮的工具调用记进对话
      var standardCalls = calls.filter(function (c) { return !c.fromText; });
      var textCalls = calls.filter(function (c) { return c.fromText; });

      if (standardCalls.length) {
        messages.push({
          role: 'assistant',
          content: res.content || '',
          tool_calls: standardCalls.map(function (c) {
            return { id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } };
          })
        });
      }
      if (textCalls.length) {
        messages.push({
          role: 'assistant',
          content: (res.content || '') + '\n\n' + textCalls.map(function (c) {
            return '```tool\n' + JSON.stringify({ name: c.name, arguments: c.args || {} }) + '\n```';
          }).join('\n')
        });
      }

      // 依次执行工具
      for (var i = 0; i < calls.length; i++) {
        var tc = calls[i];
        onToolStart(tc);
        var out = Tools.execute(tc.name, tc.args, ctx);
        usedTools.push({ name: tc.name, args: tc.args, ok: out.ok });
        onToolEnd(tc, out);

        var payload = JSON.stringify(out.ok ? out.data : { error: out.error });
        if (tc.fromText) {
          messages.push({ role: 'user', content: '【工具 ' + tc.name + ' 的执行结果】\n' + payload });
        } else {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: payload });
        }
      }
    }

    return {
      content: '（已达到工具调用上限 ' + MAX_STEPS + ' 步。建议换个更具体的问题，或直接说"给我讲讲这个考点"。）',
      usedTools: usedTools,
      steps: MAX_STEPS,
      exhausted: true
    };
  }

  return {
    run: run,
    buildSystem: buildSystem,
    learningProfile: learningProfile,
    compactHistory: compactHistory,
    PERSONAS: PERSONAS,
    MAX_STEPS: MAX_STEPS
  };
})();
