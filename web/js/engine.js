/* AI 教学引擎：
 * 1) 内置 "AI 名师"：基于知识树内容编排讲解/举例/追问/验收的对话流（无 API Key 也可用）；
 * 2) 可选 LLM 客户端：配置 OpenAI 兼容 API（DeepSeek/Kimi/通义）后走真实模型流式回复；
 * 3) Judge 判题器：选择题精确匹配，填空题归一化比对（数值容差/全半角/空格）。
 */
window.AIEngine = (function () {
  var nodes = {}, byKid = {};
  KDATA.categories.forEach(function (cat) {
    cat.chapters.forEach(function (ch) {
      ch.nodes.forEach(function (n) { nodes[n.id] = n; });
    });
  });
  QDATA.forEach(function (q) {
    (byKid[q.kid] = byKid[q.kid] || []).push(q);
  });
  function shuffle(a) {
    var arr = a.slice();
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function getNode(id) { return nodes[id]; }
  function questionsOf(kid) { return byKid[kid] || []; }
  /* 加权抽题：真题改编(3) > 经典例题(2) > 自定义/模拟题(1.5)，再按难度贴近知识点难度加权 */
  function weightedPick(qs, kid) {
    var n = nodes[kid];
    var target = n ? n.difficulty : 2;
    var weights = [];
    var sum = 0;
    qs.forEach(function (q) {
      var w = 2;
      if (q.sourceType === '真题改编') w = 3;
      else if (q.sourceType === '经典例题') w = 2.2;
      else if (q.sourceType === '模拟题') w = 1.6;
      var d = Math.abs((q.difficulty || 2) - target);
      if (d > 1) w *= 0.55;
      weights.push(w); sum += w;
    });
    var r = Math.random() * sum;
    for (var i = 0; i < qs.length; i++) {
      r -= weights[i];
      if (r <= 0) return qs[i];
    }
    return qs[qs.length - 1];
  }
  function weightedSort(qs, kid) {
    var n = nodes[kid];
    var target = n ? n.difficulty : 2;
    return qs.slice().sort(function (a, b) {
      var wa = (a.sourceType === '真题改编' ? 3 : a.sourceType === '经典例题' ? 2.2 : a.sourceType === '模拟题' ? 1.6 : 2) + 1 / (Math.abs((a.difficulty || 2) - target) + 0.3);
      var wb = (b.sourceType === '真题改编' ? 3 : b.sourceType === '经典例题' ? 2.2 : b.sourceType === '模拟题' ? 1.6 : 2) + 1 / (Math.abs((b.difficulty || 2) - target) + 0.3);
      return wb - wa;
    });
  }
  function rebuildIndex() {
    byKid = {};
    QDATA.forEach(function (q) {
      (byKid[q.kid] = byKid[q.kid] || []).push(q);
    });
  }

  /* ---------- 判题器 ---------- */
  var Judge = {
norm: function (s) {
      s = String(s == null ? '' : s).trim();
      s = s.replace(/[\uFF00-\uFFEF]/g, function (c) {
        return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
      });
      s = s.replace(/[，。；：、]/g, ',').replace(/\s+/g, '').toLowerCase();
      s = s.replace(/\\/g, '');            // 去掉 LaTeX 反斜杠：\pi -> pi
      s = s.replace(/π/g, 'pi').replace(/√/g, 'sqrt');
      s = s.replace(/²/g, '^2').replace(/³/g, '^3');
      s = s.replace(/[×x]/g, '*').replace(/÷/g, '/').replace(/−/g, '-');
      s = s.replace(/（/g, '(').replace(/）/g, ')');
      return s;
    },
    /* 判定：**只在服务端**（JUDGE_CONTRACT I1），本函数返回 Promise<boolean>。
     *
     * 历史说明（BOUNDARY §1 的硬接缝）：这里原有 checkBlank + fracVal + parseFloat
     * + 1e-6 容差，是 fail-open 的假阳性源头（"1" 对 "1+sqrt(2)" 判对）。整段已删除，
     * 比对逻辑的唯一实现 = `core/judge.py`。
     * `norm()` **保留**：它仍是 fork 最值钱的资产，前端用它做展示层的轻度归一（不参与判定）。 */
    check: function (q, userAns) {
      if (typeof MDStore === 'undefined' || !MDStore.judge) {
        return Promise.reject(new Error('存储桥未加载（web/js/api.js），无法判定'));
      }
      return MDStore.judge(q.id, userAns).then(function (r) {
        return !!(r && r.correct === true);
      });
    },
    answerText: function (q) {
      if (q.type === 'choice') return '答案：' + q.answer + '。' + (q.analysis || '');
      return '答案：' + q.answer + '。' + (q.analysis || '');
    }
  };

  /* ---------- 内置引擎 ---------- */
  function contentParagraphs(content) {
    return String(content || '').split('\n\n').filter(function (p) { return p.trim(); });
  }
  function buildExplain(n) {
    var ps = contentParagraphs(n.content);
    var out = ['**' + n.title + '**\n'];
    ps.forEach(function (p) { out.push(p); out.push(''); });
    out.push('**考研怎么考**：' + examNote(n));
    out.push('');
    out.push('先别急着背，试着用自己的话把第一段讲给我听，或点下面的快捷按钮：让我举个例子、出个题考你。');
    return out.join('\n');
  }
  function examNote(n) {
    var d = n.difficulty >= 4 ? '高频压轴，务必吃透' : n.difficulty === 3 ? '常考考点，需熟练' : '基础考点，须记牢';
    return '这道知识点是' + d + '。';
  }
  function buildExample(n) {
    if (n.example) return '举个例子：\n\n' + n.example;
    var ps = contentParagraphs(n.content);
    return '这个知识点我的讲解要点如下：\n\n' + (ps.slice(0, 2).join('\n\n')) + '\n\n要不我们直接做一道题来感受它？点"出个题考我"。';
  }
  function buildRelated(n) {
    if (!n.related || !n.related.length) return null;
    var names = n.related.map(function (id) { return '「' + (nodes[id] ? nodes[id].title : id) + '」'; });
    return '它与' + names.join('、') + '联系紧密：\n\n它们往往在同一道大题里前后衔接——比如中值定理的证明通常要先用罗尔定理构造辅助函数，再用拉格朗日。学习时把它们放在一起对比着记，效果最好。';
  }
  function buildReexplain(n) {
    var ps = contentParagraphs(n.content);
    var first = ps[0] || '';
    return '换个角度再说一遍：\n\n' + first + '\n\n如果你还是觉得绕，告诉我具体是哪一句没看懂（比如"\\varepsilon-\\delta 语言"），我专门拆开讲。';
  }
  function questionText(q, idx, total, mode) {
    var head = mode === 'accept' ? '**验收第 ' + idx + ' 题（共 ' + total + ' 题）**\n\n' : '**来练一题**\n\n';
    var srcTag = '';
    if (q.sourceType) {
      srcTag = '`「' + q.sourceType + (q.sourceYear ? '·' + q.sourceYear : '') + '」` ';
    }
    var text = head + srcTag + q.stem;
    if (q.type === 'choice') {
      text += '\n\n' + q.options.map(function (o) { return o.k + '. ' + o.t; }).join('\n');
    } else {
      text += '\n\n（填空题，直接在输入框输入你的答案）';
    }
    return text;
  }

  function newSession(kid) {
    return {
      kid: kid,
      stage: 'explain',
      practiceQ: null,
      acceptQueue: [], acceptIndex: 0, acceptTotal: 0, acceptCorrect: 0,
      summary: null
    };
  }
  function builtinStart(sess) {
    var n = nodes[sess.kid];
    return { text: buildExplain(n), opts: null };
  }
  function builtinRespond(sess, text) {
    var n = nodes[sess.kid];
    var msg = String(text || '').trim();
    // ---------- 验收进行中 ----------
    if (sess.stage === 'quiz' && sess.acceptQueue.length) {
      var qid = sess.acceptQueue[sess.acceptIndex];
      var q = QDATA.filter(function (x) { return x.id === qid; })[0];
      var ok = Judge.check(q, msg);
      if (ok) sess.acceptCorrect++;
      var feedback = ok
        ? '答对啦！解析：' + q.analysis
        : '这里记一下：' + Judge.answerText(q) + '\n\n别灰心，我把这道题收进你的错题本了。';
      sess.acceptIndex++;
      var attempt = { qid: q.id, answer: msg, correct: ok };
      if (sess.acceptIndex >= sess.acceptQueue.length) {
        // 验收结束
        var total2 = sess.acceptTotal, correct2 = sess.acceptCorrect;
        sess.stage = 'summary';
        var verdict = correct2 === total2 ? '全对，掌握得很扎实！' : correct2 >= 1 ? '整体不错，还有一两处要再看一眼。' : '这一轮波动比较大，我们明天再复习一遍。';
        return {
          text: feedback + '\n\n---\n**验收完成**：' + total2 + ' 题做对 ' + correct2 + ' 题。' + verdict + '\n\n这个知识点已经按你的表现生成复习卡片，明天（或按遗忘曲线）会自动出现在复习队列里。可以去"复习队列"看看，或继续学下一个知识点。',
          opts: null, attempt: attempt, acceptResult: { total: total2, correct: correct2 }
        };
      }
      var nq = QDATA.filter(function (x) { return x.id === sess.acceptQueue[sess.acceptIndex]; })[0];
      return { text: feedback + '\n\n' + questionText(nq, sess.acceptIndex + 1, sess.acceptTotal, 'accept'), opts: nq.type === 'choice' ? nq.options : null, attempt: attempt };
    }
    // ---------- 练习中（非验收） ----------
    if (sess.practiceQ) {
      var pq = sess.practiceQ;
      sess.practiceQ = null;
      var pok = Judge.check(pq, msg);
      return pok
        ? { text: '挺好，答对了！思路对的话注意总结题型。解析：' + pq.analysis, opts: null, attempt: { qid: pq.id, answer: msg, correct: true } }
        : { text: '错了没关系，看看解析：' + Judge.answerText(pq) + '\n\n错题已进错题本，回头在"错题本"里重练。', opts: null, attempt: { qid: pq.id, answer: msg, correct: false } };
    }
    // ---------- 触发验收 ----------
    if (/学会|验收|考考|测验/.test(msg)) { return startAccept(sess); }
    if (/出题|练练|做题|考我|来个题/.test(msg)) {
      var qs = questionsOf(sess.kid);
      if (!qs.length) return { text: '这个知识点暂时还没有配套题目，我建议你换一个知识点练，或先在设置里导入自己的题。', opts: null };
      var one = weightedPick(qs, sess.kid);
      sess.practiceQ = one;
      return { text: questionText(one, 1, 1, 'practice'), opts: one.type === 'choice' ? one.options : null };
    }
    if (/例子|举例/.test(msg)) return { text: buildExample(n), opts: null };
    if (/没懂|不懂|再讲|详细|没听懂|听不懂/.test(msg)) return { text: buildReexplain(n), opts: null };
    if (/关系|区别|联系|相关/.test(msg)) return { text: buildRelated(n) || buildReexplain(n), opts: null };
    if (/谢谢|明白|懂了|ok|好啦/.test(msg)) {
      return { text: '不客气！感觉可以了就点"我学会了"，我出 3 道题帮你验收；还不稳就先点"举个例子"或继续追问。', opts: null };
    }
    // ---------- 默认追问 ----------
    var t = msg.length > 24 ? msg.slice(0, 24) + '…' : msg;
    return {
      text: '关于「' + n.title + '」，我听到的问题是：' + t + '。\n\n我可以从这几个角度帮你：\n1. **推到直觉**（几何/生活例子）——点"举个例子"\n2. **验证理解**——点"出个题考我"\n3. **讲清与其他考点的联系**——问我"它和XX什么关系"\n4. **直接验收**——点"我学会了"\n\n你也可以直接把没懂的那句话贴给我，我逐句拆。',
      opts: null
    };
  }
  function startAccept(sess) {
    var qs = weightedSort(questionsOf(sess.kid), sess.kid);
    if (!qs.length) {
      sess.stage = 'summary';
      return { text: '这个知识点还没有配套题目，我先记你"已学习"。可以到"复习队列"查看刚生成的卡片。', opts: null };
    }
    var take = qs.slice(0, 3);
    sess.stage = 'quiz';
    sess.acceptQueue = take.map(function (q) { return q.id; });
    sess.acceptIndex = 0; sess.acceptTotal = take.length; sess.acceptCorrect = 0;
    var q = take[0];
    return { text: '好，来验收！我出 ' + take.length + ' 道题，做完给你评级。\n\n' + questionText(q, 1, take.length, 'accept'), opts: q.type === 'choice' ? q.options : null };
  }
  function builtinHint(sess) {
    return [
      '举个例子', '出个题考我', '我没听懂', '和别的知识什么关系', '我学会了'
    ];
  }

  /* ---------- LLM 客户端 ---------- */
  function systemPrompt(kid, stage) {
    var n = nodes[kid];
    var stageText = stage === 'quiz' ? 'quiz（出题验收中：一次一题，答完点评再出下一题，不直接给完整答案）'
      : stage === 'summary' ? 'summary（总结阶段）' : 'explain（讲解中：先直觉后严格，一次只讲一个点）';
    return [
      '你是一位考研数学名师，正在一对一辅导一名备战考研数学的学生。',
      '',
      '【当前教学知识点】',
      n.title,
      String(n.content || '').split('\n\n').join('\n'),
      '',
      '【教学规则】',
      '1. 讲解必须用中文，数学公式一律用 LaTeX：行内 $...$，独立公式 $$...$$。',
      '2. 先直觉后严格：先用几何直观或生活例子建立直觉，再讲严格定义。',
      '3. 每次回复不超过 300 字，讲一个点就停下来等学生反馈，禁止一次性长篇灌输。',
      '4. 主动指出该知识点的考研考法：常考题型、易错点。',
      '5. 学生答错时，不直接给完整答案，先指出思路断在哪一步，引导其自己补上（除非学生说"直接告诉我"）。',
      '6. 出验收题时一次只出一道，等学生作答后再点评并出下一道。',
      '7. 不知道的内容承认不知道，禁止编造定理和公式。',
      '',
      '【当前阶段】' + stageText,
      '',
      '【可用题库】学生作答选择题时，可先让他在选项里选；判断题由系统判分，你只负责讲解。'
    ].join('\n');
  }
  function buildMessages(sess, userText) {
    var msgs = [{ role: 'system', content: systemPrompt(sess.kid, sess.stage) }];
    (sess.history || []).forEach(function (m) {
      msgs.push({ role: m.role, content: m.content });
    });
    msgs.push({ role: 'user', content: userText });
    return msgs;
  }
  async function llmChat(llmConf, messages, onDelta) {
    var base = (llmConf.base || '').replace(/\/+$/, '');
    var res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + llmConf.key
      },
      body: JSON.stringify({ model: llmConf.model, messages: messages, stream: true, temperature: 0.4 })
    });
    if (!res.ok) {
      var errText = await res.text().catch(function () { return ''; });
      throw new Error('LLM API ' + res.status + ': ' + errText.slice(0, 200));
    }
    if (!res.body) throw new Error('浏览器不支持流式响应');
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = '', full = '';
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      var n;
      while ((n = buf.indexOf('\n')) >= 0) {
        var line = buf.slice(0, n); buf = buf.slice(n + 1);
        var t = line.trim();
        if (t.indexOf('data:') === 0) {
          var data = t.slice(5).trim();
          if (data === '[DONE]') { reader.cancel(); return full; }
          try {
            var j = JSON.parse(data);
            var delta = j.choices && j.choices[0] && j.choices[0].delta ? (j.choices[0].delta.content || '') : '';
            if (delta) { full += delta; onDelta(delta); }
          } catch (e) { /* 忽略无法解析的分片 */ }
        }
      }
    }
    return full;
  }

  return {
    getNode: getNode,
    questionsOf: questionsOf,
    rebuildIndex: rebuildIndex,
    Judge: Judge,
    newSession: newSession,
    builtinStart: builtinStart,
    builtinRespond: builtinRespond,
    builtinHint: builtinHint,
    systemPrompt: systemPrompt,
    buildMessages: buildMessages,
    llmChat: llmChat
  };
})();
