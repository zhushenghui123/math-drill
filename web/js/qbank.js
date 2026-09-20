/* web/js/qbank.js —— 题库浏览：栏目页（题卡墙）+ 题目详情页。规格：ADR-017。
 *
 * 三条纪律（改这里之前先读）：
 *   ① **只走 MDStore**（web/js/api.js）：本文件不许出现 fetch / XMLHttpRequest
 *      —— 全站唯一 HTTP 出口是 api.js（BOUNDARY §1）。
 *   ② **渲染一律借 app.js 的壳**（`MDShell.esc / md / head`）：题面里的 LaTeX 由它交给
 *      KaTeX；自己再写一套转义 = 两处真值。
 *   ③ **服务端不回答案**（core/store.py 的列白名单），所以这里**没有**任何"显示正确答案"
 *      的分支 —— 别自己造一个，那正是 ADR-017 决策 3 要挡的东西。
 *
 * 数据形态（服务端 `modules/qbank/module.py`）：
 *   list   → {subjects:[{id,total,done,mastered,coverage,score,accuracy}], items:[…], counts}
 *   detail → {question:{…}, attempts:[{day,verdict,correct}], done, correct, notes:[…]}
 */
(function (root) {
  'use strict';

  /* 学科 id → 中文名。**只是兜底**：真值来自 app.js 的知识树（KDATA.categories），
     题库里出现树外学科时才会用到这里的名字。 */
  var SUBJECT_NAMES = { calculus: '高等数学', linear: '线性代数', probability: '概率论与数理统计' };
  /* 难度 1-4 的**显示标签**（数值才是真值，见 ARCHITECTURE §3.1：difficulty INT 1-4）。 */
  var DIFF_LABEL = { 1: '入门', 2: '基础', 3: '进阶', 4: '挑战' };
  var NAV_LIMIT = 200;      // 栏目页一屏最多拉多少题（服务端上限 200）

  var subjectsCache = null; // /m/qbank/list 的 subjects（侧栏与栏目页共用，避免两处口径）

  function shell() { return root.MDShell; }
  function api() { return root.MDStore; }
  function main() { return document.getElementById('main'); }
  function esc(s) { return shell().esc(s); }

  function subjectName(id) {
    var cats = (root.KDATA && root.KDATA.categories) || [];
    for (var i = 0; i < cats.length; i++) if (cats[i].id === id) return cats[i].name;
    return SUBJECT_NAMES[id] || id || '未归类';
  }

  /* 学科色：直接取知识树里那一项的颜色（没有就用中性色）—— 不自己定一套配色。 */
  function subjectColor(id) {
    var cats = (root.KDATA && root.KDATA.categories) || [];
    for (var i = 0; i < cats.length; i++) if (cats[i].id === id) return cats[i].color;
    return 'var(--line-2)';
  }

  /* 公式命令 → 可读符号。只覆盖常见的那几个：认不出的命令一律换成空格
     （卡片只是"一眼预览"，认错一个符号的代价远小于在卡片里塞满反斜杠）。 */
  var TEX_WORD = {
    '\\lim': 'lim', '\\sin': 'sin', '\\cos': 'cos', '\\tan': 'tan', '\\cot': 'cot',
    '\\ln': 'ln', '\\log': 'log', '\\exp': 'exp', '\\max': 'max', '\\min': 'min',
    '\\to': '→', '\\infty': '∞', '\\cdot': '·', '\\times': '×', '\\pm': '±',
    '\\leq': '≤', '\\geq': '≥', '\\neq': '≠', '\\approx': '≈',
    '\\sum': 'Σ', '\\prod': 'Π', '\\int': '∫', '\\sqrt': '√',
    '\\pi': 'π', '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\theta': 'θ',
    '\\lambda': 'λ', '\\mu': 'μ', '\\sigma': 'σ', '\\varphi': 'φ'
  };

  /* 题干预览：卡片上只给一行人话，完整题面在详情页渲染（那时才交给 KaTeX） */
  function preview(stem) {
    return String(stem == null ? '' : stem)
      .replace(/\$\$([\s\S]*?)\$\$/g, ' $1 ')
      .replace(/\$([^$]*)\$/g, ' $1 ')
      .replace(/\\left|\\right|\\displaystyle/g, '')
      .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, ' $1/$2 ')
      .replace(/\\[a-zA-Z]+/g, function (m) { return TEX_WORD[m] || ' '; })
      .replace(/[{}]/g, '')
      .replace(/\s*([/·×→≈≠≤≥])\s*/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function stars(n) {
    var k = Math.max(1, Math.min(4, parseInt(n, 10) || 2));
    return '★★★★'.slice(0, k) + '☆☆☆☆'.slice(0, 4 - k);
  }

  function diffHtml(n) {
    var k = Math.max(1, Math.min(4, parseInt(n, 10) || 2));
    return '<span class="qb-diff" title="难度系数 ' + k + '/4（' + (DIFF_LABEL[k] || '') + '）">' +
      '<b>' + stars(k) + '</b> ' + esc(DIFF_LABEL[k] || '') + '</span>';
  }

  function stateBadge(item) {
    if (!item.done) return '<span class="qb-tag qb-tag-new">未做</span>';
    if (item.correct > 0) return '<span class="qb-tag qb-tag-ok">做对过</span>';
    return '<span class="qb-tag qb-tag-bad">做错过</span>';
  }

  /* ---------------------------------------------------------------- 侧栏栏目 */

  function fillNav(subjects) {
    var box = document.getElementById('nav-subjects');
    if (!box) return;
    if (!subjects || !subjects.length) { box.hidden = true; return; }
    var html = '<div class="nav-group-title">题库</div>';
    subjects.forEach(function (s) {
      html += '<a href="#/s/' + encodeURIComponent(s.id) + '" class="nav-item" data-route="/s/' + esc(s.id) + '">' +
        '<span class="nav-dot" style="background:' + esc(subjectColor(s.id)) + '"></span>' +
        '<span>' + esc(subjectName(s.id)) + '</span>' +
        '<i class="nav-count">' + s.total + '</i></a>';
    });
    box.innerHTML = html;
    box.hidden = false;
    var cur = (location.hash || '').replace(/^#/, '');
    var act = cur.match(/^\/s\/(.+)$/);
    if (act) setNavActive('/s/' + act[1]);
  }

  function setNavActive(route) {
    var items = document.querySelectorAll('.nav-item');
    for (var i = 0; i < items.length; i++) {
      var a = items[i];
      if (a.getAttribute('data-route') === route) a.classList.add('active');
      else a.classList.remove('active');
    }
  }

  /* 侧栏只拉一次；失败就静默隐藏（题库不在时侧栏不该有半个空标题） */
  function loadSubjects() {
    if (subjectsCache) return Promise.resolve(subjectsCache);
    return api().qbankList({ limit: 1 }).then(function (d) {
      subjectsCache = d.subjects || [];
      fillNav(subjectsCache);
      return subjectsCache;
    }).catch(function () {
      subjectsCache = null;
      fillNav([]);
      return [];
    });
  }

  /* ---------------------------------------------------------------- 栏目页 */

  function widget(label, value, unit, hint) {
    return '<div class="qb-widget"><div class="qb-w-num">' + value +
      (unit ? '<span class="qb-w-unit">' + unit + '</span>' : '') + '</div>' +
      '<div class="qb-w-label">' + esc(label) + '</div>' +
      (hint ? '<div class="qb-w-hint">' + esc(hint) + '</div>' : '') + '</div>';
  }

  function pageSubject(subject) {
    var host = main();
    host.innerHTML = shell().head(subjectName(subject), '载入题库…');
    api().qbankList({ subject: subject, limit: NAV_LIMIT }).then(function (d) {
      var s = (d.subjects || []).filter(function (x) { return x.id === subject; })[0] ||
              { total: 0, done: 0, mastered: 0, coverage: 0, score: 0, accuracy: 0, attempts: 0 };
      var items = d.items || [];
      // 侧栏/其它页可能还没拉过 subjects（例如直接开链接进来）—— 顺手补上
      if (!subjectsCache) { subjectsCache = d.subjects || []; fillNav(subjectsCache); }
      var html = shell().head(subjectName(subject),
        '共 ' + s.total + ' 题 · 做过 ' + s.done + ' 题 · 本页 ' + items.length + ' 张卡片');

      html += '<div class="qb-widgets">' +
        widget('完成度', s.coverage, '%', '做过的题 ÷ 总题数') +
        widget('综合评分', s.score, '%', '做对过的题 ÷ 总题数') +
        widget('题量', s.total, ' 题', '该栏目现有题目') +
        widget('做题正确率', s.accuracy, '%', '累计 ' + s.attempts + ' 次作答') +
        '</div>';

      if (!items.length) {
        html += '<div class="card mt16"><div class="card-title">这个栏目还没有题</div>' +
          '<div style="color:var(--ink-3);font-size:13px;line-height:1.7">' +
          '数据提炼跑完、题目灌进 <code>questions</code> 表之后，这里会自动出现卡片。</div></div>';
      } else {
        html += '<div class="qb-grid">' + items.map(cardHtml).join('') + '</div>';
      }
      host.innerHTML = html;
      setNavActive('/s/' + subject);
    }).catch(function (e) {
      host.innerHTML = shell().head(subjectName(subject), '载入失败') + errorCard(e);
    });
  }

  function cardHtml(item) {
    return '<a class="qb-card" href="#/q/' + encodeURIComponent(item.qid) + '">' +
      '<div class="qb-card-top">' + stateBadge(item) + diffHtml(item.difficulty) + '</div>' +
      '<div class="qb-card-stem">' + esc(preview(item.stem || item.qid)) + '</div>' +
      '<div class="qb-card-foot">' +
        '<span class="qb-kid">' + esc(item.kidTitle || item.kid || '未映射考点') + '</span>' +
        '<span class="qb-src">' + esc(shortSource(item.source)) + '</span>' +
      '</div>' +
      (item.done ? '<div class="qb-card-note">' + (item.hasNote ? '有 agent 复盘' : '暂无复盘') + '</div>' : '') +
      '</a>';
  }

  function shortSource(src) {
    var s = String(src || '');
    if (s.indexOf('ocr:') === 0) return 'OCR · ' + s.slice(4);
    return s || '自产题源';
  }

  /* ---------------------------------------------------------------- 详情页 */

  function pageQuestion(qid) {
    var host = main();
    host.innerHTML = shell().head('题目', '载入中…');
    api().qbankDetail(qid).then(function (d) {
      host.innerHTML = detailHtml(d);
      // 详情页也点亮它所属的栏目（侧栏由 qbank.js 自己管，见 app.js 的 setActiveNav）
      if (d.question && d.question.subject) setNavActive('/s/' + d.question.subject);
    }).catch(function (e) {
      host.innerHTML = shell().head('题目', '载入失败') + errorCard(e);
    });
  }

  function detailHtml(d) {
    var q = d.question || {};
    var html = shell().head(
      q.kidTitle || q.qid,
      (q.chapter ? esc(q.chapter) + ' · ' : '') + '题号 ' + esc(q.qid),
      '<button class="btn" onclick="location.hash=\'#/s/' + encodeURIComponent(q.subject) + '\'">返回栏目</button>'
    );

    /* 题面卡：**没做过也完整给** —— 题目本身不是答案 */
    html += '<div class="card qb-question">' +
      '<div class="qb-q-top">' + diffHtml(q.difficulty) +
        '<span class="qb-meta">类型 ' + esc(q.type || '—') + ' · 判定 ' + esc(q.answerType || '—') + '</span>' +
        '<span class="qb-meta">' + esc(shortSource(q.source)) + '</span>' +
      '</div>' +
      '<div class="qb-q-body">' + shell().md(q.stem || '（这道题还没有题面）') + '</div>' +
    '</div>';

    /* 作答史卡 + 复盘卡 */
    html += '<div class="card mt16 qb-notes">' + notesHtml(d) + '</div>';
    return html;
  }

  function notesHtml(d) {
    var out = '<div class="card-title">我的作答与复盘' +
      '<span class="sub">' + (d.done ? '做过 ' + d.attempts.length + ' 次' : '还没做过') + '</span></div>';

    if (!d.done) {
      out += '<div class="qb-empty">' +
        '<div class="qb-empty-title">这道题你还没做过</div>' +
        '<div class="qb-empty-body">做完之后，agent 会把 <b>当时你怎么想的、错在哪</b> 写进这里；' +
        '现在先只给你题面，不剧透答案。</div>' +
        '<button class="btn primary" onclick="location.hash=\'#/quiz\'">去每日一练</button>' +
        '</div>';
      return out;
    }

    out += '<div class="qb-attempts">' + d.attempts.map(function (a) {
      var ok = a.correct === true;
      return '<span class="qb-attempt ' + (ok ? 'ok' : 'bad') + '">' + esc(a.day || '') + ' · ' +
        (ok ? '做对' : (a.correct === false ? '做错' : esc(a.verdict || '待自评'))) + '</span>';
    }).join('') + '</div>';

    if (!d.notes || !d.notes.length) {
      out += '<div class="qb-nonote">还没有 agent 复盘 —— 复盘要在与 agent 聊过之后由它写入' +
        '（写权尚未开放，见 ADR-017）。</div>';
      return out;
    }
    out += d.notes.map(function (n) {
      var badge = n.kind === 'review_wrong' ? '<span class="qb-tag qb-tag-bad">错因复盘</span>'
        : n.kind === 'review_correct' ? '<span class="qb-tag qb-tag-ok">对的思路</span>'
        : '<span class="qb-tag">讲解</span>';
      return '<div class="qb-note">' +
        '<div class="qb-note-head">' + badge +
          '<span class="qb-note-who">' + esc(n.author === 'agent' ? 'agent' : n.author) +
          ' · ' + esc(n.src || '') + (n.day ? ' · ' + esc(n.day) : '') + '</span></div>' +
        '<div class="qb-note-body">' + shell().md(n.summary) + '</div>' +
        (n.reason ? '<div class="qb-note-reason"><b>错误原因</b>：' + shell().md(n.reason) + '</div>' : '') +
        '</div>';
    }).join('');
    return out;
  }

  function errorCard(e) {
    var msg = (e && (e.message || e.code)) || String(e);
    return '<div class="card"><div class="card-title">没拿到数据</div>' +
      '<div style="color:var(--ink-3);font-size:13px;line-height:1.7">' + esc(msg) +
      '。若提示未登录，先访问 <code>/setup?t=&lt;token&gt;</code> 换一次会话 cookie。</div></div>';
  }

  root.MDQbank = {
    pageSubject: pageSubject,
    pageQuestion: pageQuestion,
    loadSubjects: loadSubjects,
    fillNav: fillNav,
    subjectName: subjectName,
    _preview: preview
  };
})(window);
