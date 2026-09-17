/* 研数 · 卡片引擎
 *
 * 把一节课堂讨论蒸馏成可打印的复习小卡片。
 *
 * 设计取舍：
 *   本地规则抽取（distill）免费、即时、离线可用 —— 保证「永远有东西可导出」；
 *   模型精炼（aiMessages + parseCards）花 1 次调用，负责把 front/back 拆干净、
 *   起好标题。两条路都产出同一种结构，UI 不关心来源。
 *
 * 本模块**纯函数**：不碰 DOM、不碰 localStorage、不发请求。方便测试。
 */
window.Cards = (function () {
  'use strict';

  /* ---------- 卡片类型 ---------- */
  var TYPES = {
    point:    { key: 'point',    name: '必记结论', short: '结论', color: '#1b4d8f' },
    pitfall:  { key: 'pitfall',  name: '易错点',   short: '易错', color: '#a33a2e' },
    question: { key: 'question', name: '疑问解答', short: '疑问', color: '#2f6b4f' },
    formula:  { key: 'formula',  name: '必记公式', short: '公式', color: '#8a5f17' },
    problem:  { key: 'problem',  name: '题目回顾', short: '题目', color: '#57574f' }
  };
  /* 打印时的排列顺序：先题后理，易错夹在结论后面 */
  var TYPE_ORDER = ['problem', 'point', 'pitfall', 'question', 'formula'];

  /* 角色名：优先用 Classroom 的，没有就本地兜底（让本模块能独立测试） */
  var FALLBACK_NAMES = { teacher: '老师', smart: '学生甲', average: '学生乙', weak: '学生丙', me: '你' };
  function nameOf(role) {
    if (window.Classroom && window.Classroom.AGENTS && window.Classroom.AGENTS[role]) {
      return window.Classroom.AGENTS[role].name;
    }
    return FALLBACK_NAMES[role] || role;
  }

  var MAX_PER_TYPE = { problem: 1, point: 5, pitfall: 4, question: 3, formula: 4 };

  /* ---------- 文本处理 ---------- */

  /* 按中文句末标点与换行切句。不切分号 —— 分号两侧通常是一句话的两半，切开丢上下文。 */
  function splitSentences(text) {
    var t = String(text == null ? '' : text).replace(/\r/g, '');
    var out = [], buf = '';
    for (var i = 0; i < t.length; i++) {
      var c = t.charAt(i);
      if (c === '\n') { if (buf.trim()) out.push(buf.trim()); buf = ''; continue; }
      buf += c;
      if (c === '。' || c === '！' || c === '？' || c === '!' || c === '?') {
        if (buf.trim()) out.push(buf.trim());
        buf = '';
      }
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  /* 抽出编号/项目符号列表项。注意 (?!\d) —— 否则 "0.5" 会被当成列表项 "0." */
  function extractListItems(text) {
    var t = String(text == null ? '' : text).replace(/\r/g, '');
    t = t.replace(/(?:^|\s)(\d{1,2})[.、)）](?!\d)\s*/g, '\n$1. ')
         .replace(/([①②③④⑤⑥⑦⑧⑨⑩])/g, '\n$1');
    return t.split('\n')
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return /^(\d{1,2}[.、)）]|[①②③④⑤⑥⑦⑧⑨⑩]|[-*])\s*/.test(l); })
      .map(function (l) { return l.replace(/^(\d{1,2}[.、)）]|[①②③④⑤⑥⑦⑧⑨⑩]|[-*])\s*/, '').trim(); })
      .filter(function (l) { return l.length >= 4; });
  }

  /* 去掉 markdown 标记与多余空白，卡片上不该出现 ** 和列表符号 */
  function cleanText(s) {
    return String(s == null ? '' : s)
      .replace(/\*\*/g, '')
      .replace(/^\s*[-*]\s+/, '')
      .replace(/^\s*\d{1,2}[.、)）](?!\d)\s*/, '')
      .replace(/^\s*[①②③④⑤⑥⑦⑧⑨⑩]\s*/, '')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  /* 给标题用：截到 n 个字，不加省略号（省略号在卡片上很难看） */
  function clip(s, n) {
    var t = cleanText(s);
    return t.length > n ? t.slice(0, n) : t;
  }

  function hash(s) {
    var h = 5381, i;
    for (i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  /* 稳定 id：同一张卡重复生成不会变成两条 */
  function cardId(type, front) { return type + '-' + hash(String(front).slice(0, 80)); }

  /* 归一化文本：忽略空白与标点差异，用于比对「这两句是不是同一句」 */
  function plainText(s) {
    return String(s == null ? '' : s).replace(/[\s。，、；：！？.,;:!?]/g, '').slice(0, 60);
  }

  /* 去重指纹：front 前 60 字（忽略空白与标点差异） */
  function fingerprint(card) {
    return card.type + '|' + plainText(card.front);
  }

  /* ---------- 结构化 ---------- */

  function makeCard(type, title, front, back, meta) {
    var t = TYPES[type] ? type : 'point';
    var f = cleanText(front);
    if (!f) return null;
    var c = {
      id: cardId(t, f),
      type: t,
      title: clip(title, 22) || TYPES[t].name,
      front: f,
      back: cleanText(back || ''),
      kid: (meta && meta.kid) || '',
      kidTitle: (meta && meta.kidTitle) || '',
      src: (meta && meta.src) || 'class',
      ts: (meta && meta.ts) || 0
    };
    return c;
  }

  /* 清洗一批卡：去空、去重、按类型限量、补 meta */
  function normalize(list, meta) {
    var seen = {}, out = [];
    var counts = {};
    (list || []).forEach(function (raw) {
      if (!raw) return;
      var type = TYPES[raw.type] ? raw.type : 'point';
      if (!raw.front && raw.back) { raw.front = raw.back; raw.back = ''; }
      var c = makeCard(type, raw.title, raw.front, raw.back, meta);
      if (!c) return;
      var fp = fingerprint(c);
      if (seen[fp]) return;
      var cap = MAX_PER_TYPE[type] || 4;
      counts[type] = counts[type] || 0;
      if (counts[type] >= cap) return;
      counts[type]++;
      seen[fp] = 1;
      out.push(c);
    });
    out.sort(function (a, b) { return TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type); });

    /* 背面如果跟别处的文字是同一句，那就是复读。
     * 同一句话常被抽中两次 —— 一次当易错点（正面），一次当公式卡的注解（背面），
     * 印在纸上就是同一句话出现两遍。清空背面，而不是删卡：卡本身还有价值。 */
    var said = {};
    out.forEach(function (c) {
      if (c.front) said[plainText(c.front)] = (said[plainText(c.front)] || 0) + 1;
      if (c.back) said[plainText(c.back)] = (said[plainText(c.back)] || 0) + 1;
    });
    out.forEach(function (c) {
      if (!c.back) return;
      // 减 1 是减掉自己这张卡的背面；还剩 >0 就说明这句话在别处也出现过
      if ((said[plainText(c.back)] || 0) - 1 > 0) c.back = '';
    });

    return out;
  }

  /* 合并新旧两批卡（旧的在前，同指纹的以新的为准） */
  function merge(existing, incoming) {
    var byFp = {}, order = [];
    (existing || []).concat(incoming || []).forEach(function (c) {
      if (!c) return;
      var fp = fingerprint(c);
      if (!byFp[fp]) order.push(fp);
      byFp[fp] = c;
    });
    return order.map(function (fp) { return byFp[fp]; });
  }

  function countByType(list) {
    var out = {};
    (list || []).forEach(function (c) { out[c.type] = (out[c.type] || 0) + 1; });
    return out;
  }

  /* ---------- 讨论记录 ---------- */
  function transcript(session) {
    return ((session && session.turns) || []).map(function (t) {
      return nameOf(t.role) + '：' + cleanText(t.text) + (t.note ? '（' + t.note + '）' : '');
    }).join('\n');
  }

  /* 从一段文本里抽 $...$ 或 \\(...\\) 包裹的 LaTeX。
     返回 {tex, context}：context 是它所在的那句话 —— 单看一个公式没意义，
     得知道它是拿来干什么的，所以公式卡会把原句放到背面。 */
  function latexFragments(text) {
    var t = String(text == null ? '' : text);
    var out = [];
    splitSentences(t).forEach(function (sent) {
      var re = /\$\$?([^$]+?)\$\$?|\\\((.+?)\\\)/g, m;
      while ((m = re.exec(sent)) !== null) {
        var tex = (m[1] || m[2] || '').trim();
        if (tex.length >= 3) out.push({ tex: tex, context: cleanText(sent) });
      }
    });
    return out;
  }

  /* 这个 LaTeX 片段值不值得单独做一张卡？
   * 这段数据里的 $...$ 大量用于正文里的行内数学（"$\sin x$ 等价于 $x$"），
   * 那些碎片单独拎出来毫无意义 —— 不加这道闸，一节课能挖出五张垃圾公式卡。
   *
   * 判据分三层，关键是别把「符号」当成「结构」：
   *   1. 含等号      → 是结论式，直接认（$a^2+b^2=c^2$）
   *   2. 含结构命令  → 是个式子（\frac \lim \int …）
   *   3. 只有符号    → 得够长才算（\to \infty \sim …）
   *
   * 第 2、3 层还都要求「含变量」—— 光有数字和符号的片段不是公式。
   * 反面教材：$1^{\infty}$ 由一个数字、一个上标和一个「符号」组成，
   * 早期版本把 \infty 归进结构命令，于是这个「未定式标记」被当成公式卡，
   * 而且它的注解句跟同一节课的易错点卡一字不差 —— 印出来是两张废纸。
   * （把长度阈值当判据也不管用：写成 $1^{\infty}$ 有 11 个字符，照样漏过去。） */
  var FORMULA_STRUCT = /\\frac|\\lim|\\int|\\sum|\\prod|\\iint|\\oint|\\sqrt|\\begin\{|\\partial|\\left|\\right|\\binom|\\overline|\\vec|\\sim|\\equiv/;
  var FORMULA_SYMBOL = /\\pm|\\mp|\\leq|\\geq|\\neq|\\approx|\\cdot|\\times|\\div|\\to|\\infty|\\Rightarrow|\\Leftrightarrow/;
  function isFormulaLike(tex) {
    var t = String(tex || '').trim();
    if (t.indexOf('=') >= 0) return true;
    // 剥掉 \frac \lim 这类命令后，还得剩下至少一个变量字母
    if (!/[a-zA-Z]/.test(t.replace(/\\[a-zA-Z]+/g, ''))) return false;
    if (FORMULA_STRUCT.test(t)) return true;
    return FORMULA_SYMBOL.test(t) && t.length >= 10;
  }

  /* ---------- 本地规则抽取 ---------- */

  var POINT_WORDS = /记住|注意|必须|关键|结论|因此|所以|本质|口诀|条件|前提|只要|只有|千万|一定|核心|要点|总结|归结|等于|记住一点/;
  var PIT_WORDS = /错|误|混淆|混了|坑|不能|不对|别|问题在于|忽略了|想当然|当成|误以为|常见错误/;

  function distill(session, node) {
    session = session || {};
    var kid = session.kid || (node && node.id) || '';
    var kidTitle = (node && node.title) || session.kidTitle || kid;
    var meta = { kid: kid, kidTitle: kidTitle, src: 'class', ts: Date.now() };
    var turns = session.turns || [];
    var raw = [];

    /* --- 题目回顾 --- */
    var q = session.question;
    if (q && q.stem) {
      var back = [];
      if (q.answer) back.push('答案：' + q.answer);
      if (q.analysis) back.push('思路：' + cleanText(q.analysis));
      raw.push({ type: 'problem', title: '本节讨论的题', front: q.stem, back: back.join('\n') });
    }

    /* --- 必记结论：以老师最后一段（小结 / 点评）为主 --- */
    var teacherTurns = turns.filter(function (t) { return t.role === 'teacher'; });
    var lastTeacher = teacherTurns.length ? teacherTurns[teacherTurns.length - 1].text : '';
    var items = extractListItems(lastTeacher);
    if (items.length >= 2) {
      items.slice(0, MAX_PER_TYPE.point).forEach(function (it, i) {
        raw.push({ type: 'point', title: '必记 ' + (i + 1), front: it });
      });
    } else {
      var sents = splitSentences(lastTeacher).filter(function (s) { return cleanText(s).length >= 8; });
      var picked = sents.filter(function (s) { return POINT_WORDS.test(s); });
      if (picked.length < 2) picked = sents;                      // 关键词没命中就用整段的前几句兜底
      picked.slice(0, MAX_PER_TYPE.point).forEach(function (s, i) {
        raw.push({ type: 'point', title: '必记 ' + (i + 1), front: s });
      });
    }

    /* --- 易错点：老师点评里点名到某个学生的句子 --- */
    var studentNames = [nameOf('smart'), nameOf('average'), nameOf('weak')];
    teacherTurns.forEach(function (t) {
      splitSentences(t.text).forEach(function (s) {
        var hit = studentNames.filter(function (n) { return s.indexOf(n) >= 0; });
        if (!hit.length) return;
        if (!PIT_WORDS.test(s)) return;
        raw.push({
          type: 'pitfall',
          title: '易错 · ' + hit.join('、'),
          front: s,
          back: ''
        });
      });
    });

    /* --- 疑问解答：学生问句 + 其后老师的头两句 --- */
    for (var i = 0; i < turns.length; i++) {
      var t = turns[i];
      if (t.role === 'teacher' || t.role === 'me') continue;
      var qs = splitSentences(t.text).filter(function (s) { return /[？?]/.test(s) && cleanText(s).length >= 6; });
      if (!qs.length) continue;
      var ans = '';
      for (var j = i + 1; j < turns.length; j++) {
        if (turns[j].role === 'teacher') { ans = splitSentences(turns[j].text).slice(0, 2).join(''); break; }
      }
      raw.push({ type: 'question', title: nameOf(t.role) + '问', front: qs[0], back: ans });
    }

    /* --- 必记公式：只留真正像公式的，并带上它出现的那句话当注解 --- */
    var pool = [];
    pool = pool.concat(latexFragments((q && q.analysis) || ''));
    teacherTurns.forEach(function (t) { pool = pool.concat(latexFragments(t.text)); });
    // 黑板上的式子是人主动写上去的，一定是有意为之，无条件保留
    (session.board || []).forEach(function (b) {
      if (b && b.expr) pool.push({ tex: String(b.expr).trim(), context: '在黑板上写下的式子' });
    });
    var seenTex = {};
    pool.forEach(function (f) {
      if (seenTex[f.tex]) return;
      if (!isFormulaLike(f.tex)) return;
      seenTex[f.tex] = 1;
      // 把原句当注解，但如果原句除了这个公式本身就没别的信息（"$\int_0^1 x^2dx$"），
      // 那就别放背面 —— 否则卡片正反面是同一句话，纯浪费纸。
      var ctx = f.context || '';
      if (ctx.replace(/\$[^$]*\$/g, '').replace(/[，。；：、！？,.;:!?\s]/g, '').length < 4) ctx = '';
      raw.push({ type: 'formula', title: '必记公式', front: '$' + f.tex + '$', back: ctx });
    });

    /* 一张卡如果整个就是「一串并列公式的清单」（剥掉数学片段后不剩文字），
     * 那它列到的公式就不要再单独拆卡 —— 否则同一句话会变成四张卡，看着像在凑数。
     * 两条约束都必要：
     *   - 至少两个并列公式才叫「清单」。整节课只讲了一个公式时，那张结论卡
     *     也是纯公式，但它不是清单，不该把公式卡一起干掉。
     *   - 剥掉公式后还剩文字（「记住：…，这就是第二个重要极限」）说明有语境，
     *     这种卡提到的公式该单独留一张。 */
    var pureLists = raw.filter(function (c) {
      if (c.type === 'formula' || !c.front) return false;
      var f = String(c.front);
      var math = f.match(/\$[^$]*\$/g) || [];
      if (math.length < 2) return false;
      return f.replace(/\$[^$]*\$/g, '')
        .replace(/[，。；：、！？,.;:!?\s]/g, '').length === 0;
    }).map(function (c) { return plainText(c.front); });

    if (pureLists.length) {
      raw = raw.filter(function (c) {
        if (c.type !== 'formula') return true;
        var t = plainText(String(c.front || '').replace(/\$/g, ''));
        if (!t) return true;
        return !pureLists.some(function (list) { return list.indexOf(t) >= 0; });
      });
    }

    return normalize(raw, meta);
  }

  /* ---------- 模型精炼 ---------- */

  var AI_SYSTEM = [
    '你是考研数学助教，负责把一节课堂讨论整理成复习卡片。',
    '只输出一个 JSON 数组，不要任何解释文字，不要 ``` 代码块围栏。',
    '每个元素形如：',
    '{"type":"point|pitfall|question|formula|problem","title":"不超过 14 字的标题","front":"卡片正面","back":"卡片背面，可为空字符串"}',
    '',
    '各类型的要求：',
    '- point：必记结论。front 写结论本身，back 写适用条件或反例。',
    '- pitfall：易错点。front 写**错误的说法**（学生的原话最好），back 写**正确理解**。这是最有价值的一类，认真拆。',
    '- question：疑问。front 写问题，back 写解答。',
    '- formula：公式。front 写公式名，back 写 LaTeX（用 $ 包裹）。',
    '- problem：题目。front 写题干，back 写答案与关键思路。',
    '',
    '硬性要求：最多 10 张，宁缺毋滥；不要把客套话、寒暄、重复的话整理进去；',
    '数学公式一律用 $...$ 包裹的 LaTeX；中文表述，不要出现「作为 AI」这类话。'
  ].join('\n');

  function aiMessages(session, node) {
    var kidTitle = (node && node.title) || session.kidTitle || session.kid || '';
    var q = session.question;
    var lines = [];
    lines.push('【考点】' + kidTitle);
    if (q && q.stem) {
      lines.push('【本节讨论的题】' + cleanText(q.stem));
      if (q.answer) lines.push('【正确答案】' + q.answer);
      if (q.analysis) lines.push('【解析】' + cleanText(q.analysis));
    }
    if (session.reason) lines.push('【为什么讨论这个】' + cleanText(session.reason));
    lines.push('');
    lines.push('【讨论记录】');
    lines.push(transcript(session));
    return [
      { role: 'system', content: AI_SYSTEM },
      { role: 'user', content: lines.join('\n') }
    ];
  }

  /* 从模型输出里解析卡片。解析不了返回 null（调用方退回本地抽取，不要炸）。 */
  function parseCards(text, meta) {
    var s = String(text == null ? '' : text).trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    var a = s.indexOf('['), b = s.lastIndexOf(']');
    if (a < 0 || b <= a) return null;
    var arr;
    try { arr = JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
    if (!Array.isArray(arr) || !arr.length) return null;
    var list = [];
    for (var i = 0; i < arr.length; i++) {
      var it = arr[i];
      if (!it || typeof it !== 'object') continue;
      list.push({
        type: it.type,
        title: it.title,
        front: it.front != null ? it.front : it.text,
        back: it.back
      });
    }
    if (!list.length) return null;
    return normalize(list, meta);
  }

  /* ---------- 打印用的静态 HTML ---------- */
  /* 单独放在这里（而不是 app.js）是为了能脱离 DOM 直接测。 */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* 公式：交给调用方注入的 render 函数（浏览器里是 KaTeX）。
     没有 render 时退化成等宽原文，保证任何环境都能出卡片。 */
  function formulaHtml(tex, render) {
    if (render) {
      try { return render(tex); } catch (e) { /* fallthrough */ }
    }
    return '<span class="pk-tex-raw">' + esc(tex) + '</span>';
  }

  /* 卡片正文：把 $...$ 交给 render，其余转义 */
  function richText(s, render) {
    var parts = String(s == null ? '' : s).split(/\$([^$\n]+?)\$/g);
    var out = '';
    for (var i = 0; i < parts.length; i++) {
      out += (i % 2 === 1) ? formulaHtml(parts[i], render) : esc(parts[i]).replace(/\n/g, '<br/>');
    }
    return out;
  }

  function cardHtml(card, render) {
    var t = TYPES[card.type] || TYPES.point;
    var h = '';
    h += '<div class="pk-card pk-' + t.key + '" style="--pk:' + t.color + '">';
    h += '<div class="pk-head"><span class="pk-type">' + esc(t.short) + '</span>' +
         '<span class="pk-kid">' + esc(card.kidTitle || card.kid || '') + '</span></div>';
    h += '<div class="pk-title">' + richText(card.title, render) + '</div>';
    h += '<div class="pk-front">' + richText(card.front, render) + '</div>';
    if (card.back) h += '<div class="pk-back">' + richText(card.back, render) + '</div>';
    h += '</div>';
    return h;
  }

  /* 整份打印文档的内容（不含 <html> 外壳，便于塞进 #print-root） */
  function deckHtml(list, opts) {
    opts = opts || {};
    var render = opts.render;
    var meta = opts.meta || {};
    var h = '';
    h += '<div class="pk-cover">';
    h += '<div class="pk-cover-brand">研数</div>';
    h += '<div class="pk-cover-title">' + esc(meta.title || '课堂复习卡片') + '</div>';
    h += '<div class="pk-cover-sub">' + esc(meta.sub || '') + '</div>';
    h += '<div class="pk-cover-meta">' + esc(meta.count || (list.length + ' 张')) +
         (meta.date ? ' · ' + esc(meta.date) : '') + '</div>';
    h += '</div>';
    h += list.map(function (c) { return cardHtml(c, render); }).join('');
    return h;
  }

  /* 可独立下载 / 打印的完整 HTML（存档用，双击就能再打印一次） */
  function standaloneHtml(list, opts) {
    opts = opts || {};
    var meta = opts.meta || {};
    var body = deckHtml(list, { render: null, meta: meta });
    return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n' +
      '<title>' + esc(meta.title || '课堂复习卡片') + '</title>\n' +
      '<style>\n' + CARD_CSS + '\n' + PAGE_CSS + '\n</style>\n</head>\n' +
      '<body class="pk-standalone">\n<div class="pk-deck">\n' +
      body + '\n</div>\n</body>\n</html>\n';
  }

  /* ---------- 卡片样式：唯一来源 ----------
   * 屏幕上看到的卡片、打印出来的卡片、下载的独立 HTML —— 三处共用这一份。
   * 所以「所见即所得」不是靠对齐两份模板，而是根本只有一份。
   * 字号一律用 em，由容器决定实际大小：屏幕 13.5px / 打印 10pt。
   * app.js 启动时把它注入 <head>；standaloneHtml 把它内联进文件。
   */
  var CARD_CSS = [
    '.pk-deck{display:grid;gap:.85em;grid-template-columns:repeat(auto-fill,minmax(15em,1fr));align-items:start}',
    '.pk-cover{grid-column:1/-1;border-bottom:2px solid #1a1a17;padding-bottom:.7em;margin-bottom:.15em}',
    '.pk-cover-brand{font-size:.78em;letter-spacing:.32em;color:#8b8b81}',
    '.pk-cover-title{font-size:1.42em;font-weight:600;margin-top:.15em;color:#1a1a17}',
    '.pk-cover-sub{font-size:.9em;color:#57574f;margin-top:.15em}',
    '.pk-cover-meta{font-size:.78em;color:#8b8b81;margin-top:.5em}',
    '.pk-card{break-inside:avoid;page-break-inside:avoid;border:1px solid #e4e4dd;' +
      'border-left:3px solid var(--pk,#1b4d8f);border-radius:.3em;padding:.9em 1em;' +
      'background:#fff;display:flex;flex-direction:column;overflow:hidden}',
    '.pk-head{display:flex;justify-content:space-between;align-items:baseline;gap:.6em;margin-bottom:.35em}',
    '.pk-type{font-size:.78em;font-weight:600;color:var(--pk,#1b4d8f);letter-spacing:.08em;white-space:nowrap}',
    '.pk-kid{font-size:.7em;color:#8b8b81;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.pk-title{font-size:1.02em;font-weight:600;line-height:1.4;margin-bottom:.3em;color:#1a1a17}',
    '.pk-front{font-size:.95em;line-height:1.62;color:#1a1a17;word-break:break-word;font-family:Georgia,"Songti SC","Noto Serif SC",serif}',
    '.pk-back{margin-top:.6em;padding-top:.6em;border-top:1px solid #e4e4dd;font-size:.87em;line-height:1.55;color:#57574f}',
    '.pk-back::before{content:"补充 / 解答";display:block;font-size:.82em;color:#8b8b81;letter-spacing:.06em;margin-bottom:.15em}',
    '.pk-tex-raw{font-family:ui-monospace,Menlo,Consolas,monospace;background:#efefea;padding:0 .25em;border-radius:.2em}',
    '.pk-card .katex-display{margin:.3em 0}'
  ].join('\n');

  /* 独立 HTML 还需要的页面级设置 */
  var PAGE_CSS = [
    'body.pk-standalone{margin:0;padding:14mm 12mm;background:#fff;font-size:10pt;',
    'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;color:#1a1a17}',
    '@page{size:A4;margin:13mm 11mm}',
    '.pk-standalone .pk-deck{grid-template-columns:1fr 1fr;gap:5mm}'
  ].join('\n');

  return {
    TYPES: TYPES,
    TYPE_ORDER: TYPE_ORDER,
    MAX_PER_TYPE: MAX_PER_TYPE,

    splitSentences: splitSentences,
    extractListItems: extractListItems,
    cleanText: cleanText,
    latexFragments: latexFragments,
    isFormulaLike: isFormulaLike,
    transcript: transcript,

    cardId: cardId,
    fingerprint: fingerprint,
    plainText: plainText,
    normalize: normalize,
    merge: merge,
    countByType: countByType,

    distill: distill,
    aiMessages: aiMessages,
    parseCards: parseCards,

    cardHtml: cardHtml,
    deckHtml: deckHtml,
    standaloneHtml: standaloneHtml,
    CARD_CSS: CARD_CSS,
    PAGE_CSS: PAGE_CSS,
    esc: esc
  };
})();
