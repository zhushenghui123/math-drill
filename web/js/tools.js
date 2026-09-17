/* 研数 · Agent 工具集（零依赖）
 *
 * 给 AI 老师装上"手和眼睛"：它不再只能吐文本，而是可以主动查学情、翻错题本、
 * 按水平抽题、拉知识树正文、画函数图像、记笔记、标掌握。
 *
 * 每个工具：{ name, description, parameters(JSON Schema), run(args, ctx) }
 * ctx 由 app.js 注入（见 window.App.createToolContext）。
 */
window.Tools = (function () {
  'use strict';

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* ==================================================================
   * 1. 安全数学表达式求值器（递归下降，不使用 eval）
   *    支持：+ - * / ^ 、括号、隐式乘法（2x、3sin(x)）、
   *          函数 sin cos tan cot sec csc asin acos atan sinh cosh tanh
   *               ln log log2 log10 exp sqrt abs sign floor ceil round
   *          常数 pi e tau、变量 x
   * ================================================================== */
  var MathExpr = (function () {
    var FUNCS = {
      sin: Math.sin, cos: Math.cos, tan: Math.tan,
      cot: function (x) { return 1 / Math.tan(x); },
      sec: function (x) { return 1 / Math.cos(x); },
      csc: function (x) { return 1 / Math.sin(x); },
      asin: Math.asin, acos: Math.acos, atan: Math.atan,
      sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
      ln: Math.log,
      log: function (x) { return Math.log(x) / Math.LN10; },
      log2: function (x) { return Math.log(x) / Math.LN2; },
      log10: function (x) { return Math.log(x) / Math.LN10; },
      exp: Math.exp, sqrt: Math.sqrt, abs: Math.abs,
      sign: Math.sign || function (x) { return x > 0 ? 1 : x < 0 ? -1 : 0; },
      floor: Math.floor, ceil: Math.ceil, round: Math.round
    };
    var CONSTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

    function tokenize(src) {
      var s = String(src).replace(/\s+/g, '');
      var out = [], i = 0;
      while (i < s.length) {
        var c = s[i];
        if (/[0-9.]/.test(c)) {
          var j = i;
          while (j < s.length && /[0-9.]/.test(s[j])) j++;
          var num = parseFloat(s.slice(i, j));
          if (isNaN(num)) throw new Error('数字格式错误：' + s.slice(i, j));
          out.push({ t: 'num', v: num });
          i = j;
          continue;
        }
        if (/[a-zA-Z_]/.test(c)) {
          var k = i;
          while (k < s.length && /[a-zA-Z_0-9]/.test(s[k])) k++;
          out.push({ t: 'id', v: s.slice(i, k).toLowerCase() });
          i = k;
          continue;
        }
        if ('+-*/^(),'.indexOf(c) >= 0) { out.push({ t: c }); i++; continue; }
        throw new Error('不支持的字符：' + c);
      }
      return out;
    }

    function parse(tokens, xVal) {
      var pos = 0;
      function peek() { return tokens[pos]; }
      function nextTok() { return tokens[pos++]; }

      function parseExpr() {
        var v = parseTerm();
        for (;;) {
          var tk = peek();
          if (tk && (tk.t === '+' || tk.t === '-')) {
            nextTok();
            var r = parseTerm();
            v = (tk.t === '+') ? v + r : v - r;
          } else break;
        }
        return v;
      }

      function parseTerm() {
        var v = parseUnary();
        for (;;) {
          var tk = peek();
          if (tk && (tk.t === '*' || tk.t === '/')) {
            nextTok();
            var r = parseUnary();
            v = (tk.t === '*') ? v * r : v / r;
          } else if (tk && (tk.t === 'num' || tk.t === 'id' || tk.t === '(')) {
            v = v * parseUnary();          // 隐式乘法
          } else break;
        }
        return v;
      }

      function parseUnary() {
        var tk = peek();
        if (tk && (tk.t === '-' || tk.t === '+')) {
          nextTok();
          var v = parseUnary();
          return tk.t === '-' ? -v : v;
        }
        return parsePower();
      }

      function parsePower() {
        var base = parseAtom();
        var tk = peek();
        if (tk && tk.t === '^') {
          nextTok();
          return Math.pow(base, parseUnary());   // 右结合
        }
        return base;
      }

      function parseAtom() {
        var tk = nextTok();
        if (!tk) throw new Error('表达式意外结束');
        if (tk.t === 'num') return tk.v;
        if (tk.t === '(') {
          var v = parseExpr();
          var close = nextTok();
          if (!close || close.t !== ')') throw new Error('括号不匹配');
          return v;
        }
        if (tk.t === 'id') {
          if (tk.v === 'x') return xVal;
          if (Object.prototype.hasOwnProperty.call(CONSTS, tk.v)) return CONSTS[tk.v];
          if (Object.prototype.hasOwnProperty.call(FUNCS, tk.v)) {
            var nx = peek();
            if (nx && nx.t === '(') {
              nextTok();
              var arg = parseExpr();
              var cl = nextTok();
              if (!cl || cl.t !== ')') throw new Error('函数括号不匹配');
              return FUNCS[tk.v](arg);
            }
            return FUNCS[tk.v](parsePower());   // 允许 sin x
          }
          throw new Error('未知符号：' + tk.v);
        }
        throw new Error('表达式语法错误（位置 ' + (pos - 1) + '）');
      }

      var result = parseExpr();
      if (pos < tokens.length) throw new Error('表达式有多余内容');
      return result;
    }

    function compile(src) {
      var tokens = tokenize(src);
      if (!tokens.length) throw new Error('表达式为空');
      return function (x) { return parse(tokens, x); };
    }

    return { compile: compile, evalAt: function (src, x) { return compile(src)(x); } };
  })();

  /* ==================================================================
   * 2. 函数图像（纯 SVG，无图表库）
   * ================================================================== */
  function niceStep(range, target) {
    var raw = range / target;
    if (!isFinite(raw) || raw <= 0) return 1;
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
    return step * mag;
  }

  function fmtTick(v) {
    if (Math.abs(v) < 1e-9) return '0';
    var a = Math.abs(v);
    if (a >= 1e5 || a < 1e-3) return v.toExponential(1);
    var s = (Math.round(v * 1000) / 1000).toString();
    return s;
  }

  function drawGraphSVG(expr, opts) {
    opts = opts || {};
    var W = 620, H = 300, PAD = 36;
    var fn;
    try { fn = MathExpr.compile(expr); } catch (e) { return null; }

    var xmin = (opts.xmin != null && isFinite(+opts.xmin)) ? +opts.xmin : -6.283185;
    var xmax = (opts.xmax != null && isFinite(+opts.xmax)) ? +opts.xmax : 6.283185;
    if (!(xmax > xmin)) { xmin = -6.283185; xmax = 6.283185; }
    if (xmax - xmin > 1e6) xmax = xmin + 1e6;

    var N = 560, pts = [], ys = [];
    for (var i = 0; i <= N; i++) {
      var x = xmin + (xmax - xmin) * i / N;
      var y;
      try { y = fn(x); } catch (e) { y = NaN; }
      if (typeof y !== 'number' || !isFinite(y)) y = NaN;
      pts.push([x, y]);
      if (!isNaN(y)) ys.push(y);
    }
    if (!ys.length) return null;

    var ymin, ymax;
    if (opts.ymin != null && opts.ymax != null && isFinite(+opts.ymin) && isFinite(+opts.ymax) && +opts.ymax > +opts.ymin) {
      ymin = +opts.ymin; ymax = +opts.ymax;
    } else {
      var sorted = ys.slice().sort(function (a, b) { return a - b; });
      var lo = sorted[Math.floor(sorted.length * 0.05)];
      var hi = sorted[Math.floor(sorted.length * 0.95)];
      if (!isFinite(lo) || !isFinite(hi) || hi - lo < 1e-9) { lo = Math.min.apply(null, sorted); hi = Math.max.apply(null, sorted); }
      var padY = (hi - lo) * 0.18 || 1;
      ymin = lo - padY; ymax = hi + padY;
      if (ymin > 0) ymin = -padY;
      if (ymax < 0) ymax = padY;
    }
    var yRange = ymax - ymin;
    var jumpLimit = yRange * 4;   // 断点判定阈值，处理 tan 这类无界函数

    function sx(x) { return PAD + (x - xmin) / (xmax - xmin) * (W - 2 * PAD); }
    function sy(y) { return H - PAD - (y - ymin) / yRange * (H - 2 * PAD); }

    var d = '', pen = false;
    for (var k = 0; k < pts.length; k++) {
      var px0 = pts[k][0], py0 = pts[k][1];
      if (isNaN(py0) || py0 < ymin - jumpLimit || py0 > ymax + jumpLimit) { pen = false; continue; }
      var X = sx(px0), Y = sy(py0);
      if (!pen) { d += 'M' + X.toFixed(1) + ' ' + Y.toFixed(1); pen = true; }
      else d += 'L' + X.toFixed(1) + ' ' + Y.toFixed(1);
    }

    var parts = [];
    parts.push('<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:100%;display:block" xmlns="http://www.w3.org/2000/svg" role="img">');
    parts.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" rx="10" fill="#fbfcff" stroke="#e6e9f2" stroke-width="1"/>');

    // 网格
    var stepX = niceStep(xmax - xmin, 8);
    var stepY = niceStep(yRange, 5);
    var gx = Math.ceil(xmin / stepX) * stepX;
    for (; gx <= xmax; gx += stepX) {
      var gpx = sx(gx);
      parts.push('<line x1="' + gpx.toFixed(1) + '" y1="' + PAD + '" x2="' + gpx.toFixed(1) + '" y2="' + (H - PAD) + '" stroke="#eef1f8" stroke-width="1"/>');
    }
    var gy = Math.ceil(ymin / stepY) * stepY;
    for (; gy <= ymax; gy += stepY) {
      var gpy = sy(gy);
      parts.push('<line x1="' + PAD + '" y1="' + gpy.toFixed(1) + '" x2="' + (W - PAD) + '" y2="' + gpy.toFixed(1) + '" stroke="#eef1f8" stroke-width="1"/>');
    }

    // 坐标轴
    var axisY = (ymin <= 0 && ymax >= 0) ? sy(0) : H - PAD;
    var axisX = (xmin <= 0 && xmax >= 0) ? sx(0) : PAD;
    parts.push('<line x1="' + PAD + '" y1="' + axisY.toFixed(1) + '" x2="' + (W - PAD) + '" y2="' + axisY.toFixed(1) + '" stroke="#b4b2a9" stroke-width="1.2"/>');
    parts.push('<line x1="' + axisX.toFixed(1) + '" y1="' + PAD + '" x2="' + axisX.toFixed(1) + '" y2="' + (H - PAD) + '" stroke="#b4b2a9" stroke-width="1.2"/>');

    // 刻度标签
    gx = Math.ceil(xmin / stepX) * stepX;
    for (; gx <= xmax; gx += stepX) {
      if (Math.abs(gx) < stepX * 0.01) continue;
      parts.push('<text x="' + sx(gx).toFixed(1) + '" y="' + (axisY + 14).toFixed(1) + '" text-anchor="middle" font-size="10.5" fill="#8b93a7" font-family="system-ui,sans-serif">' + fmtTick(gx) + '</text>');
    }
    gy = Math.ceil(ymin / stepY) * stepY;
    for (; gy <= ymax; gy += stepY) {
      if (Math.abs(gy) < stepY * 0.01) continue;
      parts.push('<text x="' + (axisX - 6).toFixed(1) + '" y="' + (sy(gy) + 3.5).toFixed(1) + '" text-anchor="end" font-size="10.5" fill="#8b93a7" font-family="system-ui,sans-serif">' + fmtTick(gy) + '</text>');
    }

    // 曲线
    if (d) parts.push('<path d="' + d + '" fill="none" stroke="#3b5bdb" stroke-width="2.1" stroke-linejoin="round" stroke-linecap="round"/>');

    parts.push('<text x="' + (W - PAD) + '" y="' + (PAD - 12) + '" text-anchor="end" font-size="12" fill="#5a6478" font-family="ui-monospace,Menlo,monospace">y = ' + String(expr).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</text>');
    parts.push('</svg>');
    return parts.join('');
  }

  /* ==================================================================
   * 3. 工具定义
   * ================================================================== */
  var TABLE = {

    query_weakness: {
      description: '查询这名学生最薄弱的考点排行。当你需要判断"该重点补哪里"、或学生问"我哪里不行"时调用。返回按错误次数和正确率排序的考点列表。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '返回条数，默认 5' }
        }
      },
      run: function (a, ctx) {
        var limit = clamp(parseInt(a.limit, 10) || 5, 1, 20);
        var rows = [];
        ctx.allNodes().forEach(function (n) {
          var arr = ctx.attemptsOf(n.id);
          if (!arr.length) return;
          var wrong = arr.filter(function (x) { return !x.correct; }).length;
          rows.push({
            kid: n.id,
            title: n.title,
            attempts: arr.length,
            wrong: wrong,
            accuracy: Math.round((arr.length - wrong) / arr.length * 100),
            status: ctx.nodeStatus(n.id)
          });
        });
        rows.sort(function (x, y) {
          if (y.wrong !== x.wrong) return y.wrong - x.wrong;
          return x.accuracy - y.accuracy;
        });
        if (!rows.length) {
          return { ok: true, data: { tracked: 0, note: '这名学生还没有任何作答记录，无法判断薄弱点。建议先讲基础，再出题摸底。' } };
        }
        return { ok: true, data: { tracked: rows.length, weak: rows.slice(0, limit) } };
      }
    },

    get_mistakes: {
      description: '读取学生的错题本（答错且尚未做对的题目）。讲评时用它回顾"上次这道题你错在哪"，或学生说"我之前错过类似的题"时调用。',
      parameters: {
        type: 'object',
        properties: {
          kid: { type: 'string', description: '可选，只取某个知识点的错题，如 c1n2' },
          limit: { type: 'integer', description: '返回条数，默认 8' }
        }
      },
      run: function (a, ctx) {
        var limit = clamp(parseInt(a.limit, 10) || 8, 1, 30);
        var list = ctx.mistakeCards();
        if (a.kid) list = list.filter(function (x) { return x.kid === a.kid; });
        return {
          ok: true,
          data: {
            count: list.length,
            items: list.slice(0, limit).map(function (m) {
              return { qid: m.qid, kid: m.kid, title: m.title, stem: m.stem, answer: m.answer, analysis: m.analysis, wrongTimes: m.lapses };
            })
          }
        };
      }
    },

    pick_question: {
      description: '从题库里抽一道题给学生做。可指定知识点和难度。抽题会优先真题改编、并让难度贴近该考点难度。讲完一个点后想验收、或想举例时调用。',
      parameters: {
        type: 'object',
        properties: {
          kid: { type: 'string', description: '知识点 id，如 c1n2' },
          difficulty: { type: 'integer', description: '期望难度 1-5，可选' },
          exclude_ids: { type: 'array', items: { type: 'string' }, description: '排除的题目 id（避免重复出同一道）' },
          include_answer: { type: 'boolean', description: '是否返回答案与解析。给学生做题时保持 false；你要自己讲评时设 true' }
        },
        required: ['kid']
      },
      run: function (a, ctx) {
        var kid = a.kid;
        if (!kid) return { ok: false, error: '缺少参数 kid' };
        var n = ctx.node(kid);
        if (!n) return { ok: false, error: '知识点 ' + kid + ' 不存在' };
        var qs = ctx.questionsOf(kid);
        if (!qs.length) return { ok: true, data: { found: false, reason: '「' + n.title + '」暂时没有配套题目' } };

        var pool = qs;
        if (a.exclude_ids && a.exclude_ids.length) {
          var filtered = qs.filter(function (q) { return a.exclude_ids.indexOf(q.id) < 0; });
          if (filtered.length) pool = filtered;
        }
        var want = a.difficulty != null ? parseInt(a.difficulty, 10) : null;
        var weights = pool.map(function (q) {
          var w = q.sourceType === '真题改编' ? 3 : q.sourceType === '经典例题' ? 2.2 : q.sourceType === '模拟题' ? 1.6 : 2;
          if (want) w *= 1 / (Math.abs((q.difficulty || 2) - want) + 0.5);
          return w;
        });
        var sum = weights.reduce(function (s, w) { return s + w; }, 0);
        var r = Math.random() * sum, pick = pool[pool.length - 1];
        for (var i = 0; i < pool.length; i++) { r -= weights[i]; if (r <= 0) { pick = pool[i]; break; } }

        var out = ctx.publicQuestion(pick);
        if (a.include_answer) { out.answer = pick.answer; out.analysis = pick.analysis; }
        return { ok: true, data: { found: true, question: out } };
      }
    },

    get_node: {
      description: '读取知识树里某个考点的完整正文（定义、例题、关联考点、该生的掌握状态）。需要引用教材原文、或想确认前后置关系时调用。',
      parameters: {
        type: 'object',
        properties: { kid: { type: 'string', description: '知识点 id，如 c1n3' } },
        required: ['kid']
      },
      run: function (a, ctx) {
        var n = ctx.node(a.kid);
        if (!n) return { ok: false, error: '找不到知识点 ' + a.kid };
        return {
          ok: true,
          data: {
            kid: n.id,
            title: n.title,
            difficulty: n.difficulty,
            exam: n.exam === 'all' ? '数一/数二/数三' : n.exam.join('、'),
            content: n.content,
            example: n.example || null,
            related: (n.related || []).map(function (id) {
              var rn = ctx.node(id);
              return { kid: id, title: rn ? rn.title : id };
            }),
            studentStatus: ctx.nodeStatus(n.id),
            studentAccuracy: ctx.correctRate(n.id)
          }
        };
      }
    },

    search_nodes: {
      description: '按关键词在知识树里检索考点。学生问"XX 是哪个考点""哪一章讲过 XX"时调用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，如 中值定理、等价无穷小' },
          limit: { type: 'integer', description: '返回条数，默认 8' }
        },
        required: ['query']
      },
      run: function (a, ctx) {
        var q = String(a.query || '').trim();
        if (!q) return { ok: false, error: '缺少 query' };
        var limit = clamp(parseInt(a.limit, 10) || 8, 1, 20);
        var hits = ctx.allNodes().filter(function (n) {
          return n.title.indexOf(q) >= 0 || String(n.content || '').indexOf(q) >= 0;
        }).slice(0, limit).map(function (n) {
          return { kid: n.id, title: n.title, difficulty: n.difficulty, status: ctx.nodeStatus(n.id) };
        });
        return { ok: true, data: { query: q, hitCount: hits.length, hits: hits } };
      }
    },

    get_progress: {
      description: '读取这名学生的整体学习进度：掌握/学习中/未开始考点数、连续打卡天数、近 7 天正确率、距考试天数、今日待复习数。用于调整教学节奏和激励。',
      parameters: { type: 'object', properties: {} },
      run: function (a, ctx) { return { ok: true, data: ctx.progress() }; }
    },

    draw_graph: {
      description: '把数学函数画成图像直接显示给学生。讲极限、导数几何意义、单调性、凹凸性、积分面积时非常有用。只支持单变量 x。',
      parameters: {
        type: 'object',
        properties: {
          expr: { type: 'string', description: '函数表达式，如 sin(x)/x、x^3-3x、ln(x)、1/x、exp(-x^2)' },
          xmin: { type: 'number', description: 'x 轴下界，默认约 -2π' },
          xmax: { type: 'number', description: 'x 轴上界，默认约 2π' }
        },
        required: ['expr']
      },
      run: function (a, ctx) {
        var expr = String(a.expr || '').trim();
        if (!expr) return { ok: false, error: '缺少 expr' };
        var xmin = a.xmin != null ? +a.xmin : -6.283185;
        var xmax = a.xmax != null ? +a.xmax : 6.283185;
        var svg = drawGraphSVG(expr, { xmin: xmin, xmax: xmax });
        if (!svg) {
          return { ok: false, error: '表达式无法解析：' + expr + '。支持 + - * / ^ 与括号，函数 sin/cos/tan/ln/log/exp/sqrt/abs，常数 pi、e，变量 x' };
        }
        return {
          ok: true,
          data: { expr: expr, xmin: xmin, xmax: xmax, plotted: true, note: '图像已显示给学生' },
          render: { type: 'svg', html: svg }
        };
      }
    },

    save_note: {
      description: '把一条学习笔记记到某个考点下（学生自己总结的口诀、易错点都适用）。学生说"帮我记一下"或总结出规律时调用。',
      parameters: {
        type: 'object',
        properties: {
          kid: { type: 'string', description: '知识点 id' },
          text: { type: 'string', description: '笔记内容' }
        },
        required: ['kid', 'text']
      },
      run: function (a, ctx) {
        var kid = a.kid, text = String(a.text || '').trim();
        if (!kid || !text) return { ok: false, error: '缺少 kid 或 text' };
        if (!ctx.node(kid)) return { ok: false, error: '知识点 ' + kid + ' 不存在' };
        ctx.addNote(kid, text);
        return { ok: true, data: { saved: true, kid: kid, totalNotes: ctx.notesOf(kid).length } };
      }
    },

    mark_mastered: {
      description: '把某个考点标记为已掌握，系统会为它生成复习卡片并按遗忘曲线安排复习。学生明确表示学会了、或验收通过时调用。',
      parameters: {
        type: 'object',
        properties: { kid: { type: 'string', description: '知识点 id' } },
        required: ['kid']
      },
      run: function (a, ctx) {
        if (!a.kid) return { ok: false, error: '缺少 kid' };
        var n = ctx.node(a.kid);
        if (!n) return { ok: false, error: '知识点 ' + a.kid + ' 不存在' };
        ctx.markLearned(a.kid);
        return { ok: true, data: { marked: true, kid: a.kid, title: n.title, note: '已生成复习卡片，明天会出现在复习队列' } };
      }
    },

    /* ---------- 以下四个只给"学生 agent"用，老师不持有 ---------- */

    look_up: {
      description: '翻书查当前这个考点的资料。你只能看到与你水平相符的那部分——基础薄弱的同学查到的内容本来就少。想确认定义、公式或看例题时调用。',
      parameters: {
        type: 'object',
        properties: {
          what: { type: 'string', description: '你想查什么，例如「定义」「公式」「例题」' }
        }
      },
      run: function (a, ctx) {
        var m = ctx.levelMaterial ? ctx.levelMaterial() : null;
        if (!m) return { ok: true, data: { note: '手边没有这个考点的资料。' } };
        return { ok: true, data: m };
      }
    },

    recall_mistake: {
      description: '回忆你自己在这个考点上做错过的题，看看当时是怎么错的。想说"我好像在哪错过"之前先调它。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '回忆几道，默认 3' }
        }
      },
      run: function (a, ctx) {
        var ms = ctx.ownMistakes ? ctx.ownMistakes(clamp(parseInt(a.limit, 10) || 3, 1, 8)) : [];
        if (!ms.length) return { ok: true, data: { count: 0, note: '想不起来在这个考点上错过题。' } };
        return { ok: true, data: { count: ms.length, mistakes: ms } };
      }
    },

    raise_hand: {
      description: '举手。当你有一个自己实在绕不过去、必须问老师的问题时调用。调用后你这一轮就结束，老师会来回答你。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '你想问老师的问题，一句话' }
        },
        required: ['question']
      },
      run: function (a) {
        return { ok: true, data: { raised: true, question: String(a.question || '').trim() } };
      }
    },

    pass: {
      description: '这一轮你没什么想说的，跳过。别滥用——只有确实没有新想法时才用，一直弃权等于没参与。',
      parameters: { type: 'object', properties: {} },
      run: function () { return { ok: true, data: { passed: true } }; }
    }
  };

  /* 转成 OpenAI tools schema */
  function toSchema(name) {
    var t = TABLE[name];
    return {
      type: 'function',
      function: {
        name: name,
        description: t.description,
        parameters: t.parameters
      }
    };
  }

  /* 老师的工具集。注意不含「举手 / 弃权」——那是学生专属动作，
     发给老师只会让模型有机会做荒唐的事。 */
  var TEACHER_TOOLS = [
    'query_weakness', 'get_mistakes', 'pick_question', 'get_node', 'search_nodes',
    'get_progress', 'draw_graph', 'save_note', 'mark_mastered'
  ];
  var SCHEMA = TEACHER_TOOLS.map(toSchema);

  /* 学生 agent 的工具白名单：能翻书、能回忆错题、能在黑板上画图、
     能举手、能弃权 —— 但改不了学生的学情数据（不能标掌握、不能记笔记）。 */
  var STUDENT_TOOLS = ['look_up', 'recall_mistake', 'draw_graph', 'raise_hand', 'pass'];
  var STUDENT_SCHEMA = STUDENT_TOOLS.map(toSchema);

  function execute(name, args, ctx) {
    var t = TABLE[name];
    if (!t) {
      return { ok: false, error: '不存在这个工具：' + name + '。可用工具：' + Object.keys(TABLE).join('、') };
    }
    try {
      var r = t.run(args || {}, ctx);
      return r || { ok: true, data: null };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /* 给 UI 显示的中文动作名 */
  var LABELS = {
    query_weakness: '查薄弱考点',
    get_mistakes: '翻错题本',
    pick_question: '抽一道题',
    get_node: '查知识树',
    search_nodes: '检索考点',
    get_progress: '看学习进度',
    draw_graph: '画函数图像',
    save_note: '记笔记',
    mark_mastered: '标记已掌握',
    look_up: '翻书',
    recall_mistake: '回忆错题',
    raise_hand: '举手',
    pass: '这轮不说了'
  };

  return {
    SCHEMA: SCHEMA,
    TEACHER_TOOLS: TEACHER_TOOLS,
    STUDENT_SCHEMA: STUDENT_SCHEMA,
    STUDENT_TOOLS: STUDENT_TOOLS,
    TABLE: TABLE,
    LABELS: LABELS,
    names: Object.keys(TABLE),
    execute: execute,
    MathExpr: MathExpr,
    drawGraphSVG: drawGraphSVG
  };
})();
