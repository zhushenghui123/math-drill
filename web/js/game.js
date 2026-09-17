/* 游戏化核心：XP / 等级 / 成就 / 连击 / 章节点亮 / BOSS 解锁
 *
 * 设计约束（跟 cards.js 一样）：纯函数。不碰 DOM、不碰 localStorage、不发请求。
 * 所有输入都是 (state, world) 两个参数，输出是普通对象 —— 所以能脱离浏览器直接测。
 *
 * 另一个关键决策：XP 是**累加**的（存在 state.game.xp），不是从 state 反推的。
 * 反推看着优雅，但复习自评四档的 XP 不同，而 SM-2 只留 reps/lapses，
 * 反推会把这些细节抹平。所以走累加 + 幂等键：
 *   award(state, 'learn', { key: 'learn:c1n4' })  —— 同一个 key 只发一次奖。
 * 这样重复触发（改状态、重新渲染）不会刷分。
 */
window.Game = (function () {
  'use strict';

  /* ---------- XP 表 ---------- */
  var XP = {
    learn: 20,                    // 学完一个知识点
    correct: 10,                  // 答对一题
    wrong: 2,                     // 答错也给参与分 —— 不然没人敢做题
    checkin: 15,                  // 当日打卡
    card: 1,                      // 整理出一张新卡片
    boss: 80,                     // 通关章节 BOSS
    review: { 1: 2, 2: 5, 3: 8, 4: 10 }   // 复习自评：忘了 / 困难 / 记得 / 轻松
  };

  /* ---------- 等级曲线 ----------
   * 升到第 n 级需要 100 + (n-1)*60 点。
   * 全部 68 个知识点 + 204 道题首刷 ≈ 3400 XP，加上打卡与复习能到 6000+，
   * 对应 11 级左右 —— 全学完刚好"封神"，不至于几周就顶到天花板。 */
  var LEVELS = [
    '初识极限', '数轴新兵', '求导学徒', '积分见习', '级数行者', '多元探索者',
    '曲线猎手', '矩阵行者', '概率赌徒', '极限猎人', '定理克星', '考场主宰'
  ];
  var TOP_TITLE = '考场主宰';   // 超过表长度就一直用这个

  function needFor(level) { return 100 + (level - 1) * 60; }

  /* 累计 XP → 等级信息。level 从 1 开始。 */
  function levelInfo(xp) {
    var x = Math.max(0, Math.floor(xp || 0));
    var level = 1, base = 0, need = needFor(1);
    while (x >= base + need) {
      base += need;
      level++;
      need = needFor(level);
    }
    var into = x - base;
    return {
      xp: x,
      level: level,
      title: LEVELS[level - 1] || TOP_TITLE,
      into: into,                       // 本级已得
      need: need,                       // 本级总共需要
      pct: need > 0 ? Math.round(into / need * 100) : 0,
      total: base + need                // 升到下一级的累计 XP
    };
  }

  /* ---------- 状态骨架 ---------- */
  function blank() {
    return {
      xp: 0,
      achievements: {},   // id -> 'YYYY-MM-DD'
      combo: 0,           // 当日连续答对
      bestCombo: 0,
      boss: {},           // chapterKey -> { score, total, date }
      flags: {},          // 一次性标记（清空过队列、拿过满分…）
      seen: {}            // 幂等键 -> 1
    };
  }

  /* 把老存档补齐 —— 缺字段不炸，只是从零开始攒 */
  function ensure(state) {
    if (!state || typeof state !== 'object') return blank();
    if (!state.game || typeof state.game !== 'object') state.game = blank();
    var g = state.game;
    if (typeof g.xp !== 'number' || !isFinite(g.xp)) g.xp = 0;
    if (!g.achievements) g.achievements = {};
    if (typeof g.combo !== 'number') g.combo = 0;
    if (typeof g.bestCombo !== 'number') g.bestCombo = 0;
    if (!g.boss) g.boss = {};
    if (!g.flags) g.flags = {};
    if (!g.seen) g.seen = {};
    return g;
  }

  /* ---------- 发 XP ----------
   * opts.key 存在时幂等：同一个 key 只发一次。
   * 返回 { gained, levelUp, from, to, title }；被幂等挡掉时 gained=0。
   */
  function award(state, kind, opts) {
    opts = opts || {};
    var g = ensure(state);
    var amount = opts.amount;
    if (amount == null) {
      if (kind === 'review') amount = XP.review[opts.rating] || 0;
      else amount = XP[kind] || 0;
    }
    if (!amount) return null;

    if (opts.key) {
      if (g.seen[opts.key]) return null;
      g.seen[opts.key] = 1;
    }

    var before = levelInfo(g.xp);
    g.xp += amount;
    var after = levelInfo(g.xp);
    return {
      gained: amount,
      from: before.level, to: after.level,
      levelUp: after.level > before.level,
      level: after.level,
      title: after.title
    };
  }

  /* ---------- 连击 ----------
   * 答对 +1，答错清零。记录历史最高，成就用它判定。
   * 里程碑用于弹提示（10 / 25 / 50 连）。
   */
  var COMBO_MILESTONES = [5, 10, 25, 50, 100];
  function comboHit(state, correct) {
    var g = ensure(state);
    if (correct) {
      g.combo += 1;
      if (g.combo > g.bestCombo) g.bestCombo = g.combo;
    } else {
      g.combo = 0;
    }
    var milestone = null;
    if (correct && COMBO_MILESTONES.indexOf(g.combo) >= 0) milestone = g.combo;
    return { combo: g.combo, best: g.bestCombo, milestone: milestone };
  }

  /* ---------- 世界数据 ----------
   * 允许注入（测试用），不注入就从 window.KDATA / window.QDATA 读。
   * 返回拍平后的节点（带 chapterId / chapterName / categoryId）。
   */
  function defaultWorld() {
    var nodes = [], chapters = [], questions = [];
    var cats = (window.KDATA && window.KDATA.categories) || [];
    cats.forEach(function (cat, ci) {
      cat.chapters.forEach(function (ch, chi) {
        var chId = cat.id + '-' + chi;
        chapters.push({ id: chId, name: ch.name, categoryId: cat.id, categoryName: cat.name, color: cat.color });
        ch.nodes.forEach(function (n) {
          nodes.push({
            id: n.id, title: n.title, difficulty: n.difficulty,
            exam: n.exam, chapterId: chId, chapterName: ch.name, categoryId: cat.id
          });
        });
      });
    });
    ((window.QDATA) || []).forEach(function (q) {
      questions.push({ id: q.id, kid: q.kid });
    });
    return { nodes: nodes, chapters: chapters, questions: questions };
  }

  /* 按考试范围过滤节点（跟 app.js 的 nodeInTrack 保持一致） */
  function inTrack(node, track) {
    if (!track || track === 'math1') return true;
    var e = node.exam;
    if (e === 'all') return true;
    if (!Array.isArray(e)) return false;
    return e.indexOf(track) >= 0;
  }

  /* ---------- 打卡天数：从 checkins 推导，不额外存字段 ----------
   * 「连续天数」这种东西最容易跟真实记录漂移（今天忘了更新字段就永远错了）。
   * checkins 里已经有全部事实，直接算。
   * 口径跟 app.js 的 checkinOK 一致：完成全部任务 或 专注满 30 分钟。
   */
  function checkinOk(rec) {
    return !!rec && (rec.tasksDone === true || (rec.minutes || 0) >= 30);
  }
  function parseDay(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }
  function dayStr(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function shiftDay(s, n) {
    var d = parseDay(s);
    if (!d) return s;
    d.setDate(d.getDate() + n);
    return dayStr(d);
  }
  function streakInfo(checkins, today) {
    var dates = Object.keys(checkins || {}).filter(function (d) { return checkinOk(checkins[d]); }).sort();
    if (!dates.length) return { current: 0, best: 0 };
    var set = {};
    dates.forEach(function (x) { set[x] = 1; });
    var best = 1, run = 1;
    for (var i = 1; i < dates.length; i++) {
      run = (dates[i] === shiftDay(dates[i - 1], 1)) ? run + 1 : 1;
      if (run > best) best = run;
    }
    // 当前连续：今天没打卡就从昨天往回数（跟 app.js 的 calcStreak 一致）
    var cur = 0, d = set[today] ? today : shiftDay(today, -1);
    while (set[d]) { cur++; d = shiftDay(d, -1); if (cur > 9999) break; }
    return { current: cur, best: best };
  }

  /* ---------- 快照：所有成就判定都读这个 ---------- */
  function snapshot(state, world, opts) {
    state = state || {};
    opts = opts || {};
    var g = ensure(state);
    world = world || defaultWorld();
    var track = opts.track || 'math1';
    var today = opts.today || fmtToday();

    var nodes = world.nodes.filter(function (n) { return inTrack(n, track); });
    var nodeIds = {};
    nodes.forEach(function (n) { nodeIds[n.id] = 1; });

    var cards = state.cards || {};
    var learned = nodes.filter(function (n) { return cards[n.id]; }).length;

    var attempts = (state.attempts || []).filter(function (a) { return nodeIds[a.kid]; });
    var correct = attempts.filter(function (a) { return a.correct; }).length;

    /* 错题本口径跟 app.js 的 mistakeList 一致：每题只看最后一次作答 */
    var seenQ = {}, wrong = 0;
    attempts.slice().reverse().forEach(function (a) {
      if (seenQ[a.qid]) return;
      seenQ[a.qid] = 1;
      if (!a.correct) wrong++;
    });

    var checkins = state.checkins || {};
    var maxMinutes = 0;
    Object.keys(checkins).forEach(function (d) {
      var m = (checkins[d] && checkins[d].minutes) || 0;
      if (m > maxMinutes) maxMinutes = m;
    });

    /* 章节进度：本章节点全部 mastered 才算点亮 */
    var chStat = {};
    nodes.forEach(function (n) {
      var s = chStat[n.chapterId] || (chStat[n.chapterId] = { total: 0, mastered: 0 });
      s.total++;
      if (cards[n.id]) s.mastered++;
    });
    var chaptersDone = Object.keys(chStat).filter(function (k) {
      var s = chStat[k];
      return s.total > 0 && s.mastered >= s.total;
    }).length;

    var bossPassed = Object.keys(g.boss).filter(function (k) { return g.boss[k] && g.boss[k].score != null; }).length;

    var deckCards = 0;
    var deck = state.cardDeck || {};
    Object.keys(deck).forEach(function (k) { deckCards += (deck[k] || []).length; });

    var sk = streakInfo(checkins, today);

    return {
      today: today,
      xp: g.xp,
      level: levelInfo(g.xp).level,
      title: levelInfo(g.xp).title,
      streak: sk.current,
      bestStreak: sk.best,
      learned: learned,
      total: nodes.length,
      attempts: attempts.length,
      correct: correct,
      wrong: wrong,
      mistakes: wrong,
      maxMinutes: maxMinutes,
      chaptersDone: chaptersDone,
      chaptersTotal: Object.keys(chStat).length,
      chStat: chStat,
      bossPassed: bossPassed,
      deckCards: deckCards,
      bestCombo: g.bestCombo,
      combo: g.combo,
      flags: g.flags
    };
  }

  /* ---------- 成就表 ----------
   * 每条就是一个纯谓词，读 snapshot。加成就只要往这里加一行。
   * tier 只影响卡片配色：bronze / silver / gold。
   */
  var ACHIEVEMENTS = [
    { id: 'first-step', name: '万里长征第一步', desc: '完成第一次打卡', icon: '始', tier: 'bronze', check: function (c) { return c.streak >= 1 || c.bestStreak >= 1; } },
    { id: 'streak-7', name: '一周不辍', desc: '连续打卡 7 天', icon: '七', tier: 'bronze', check: function (c) { return c.bestStreak >= 7; } },
    { id: 'streak-30', name: '月度铁人', desc: '连续打卡 30 天', icon: '月', tier: 'silver', check: function (c) { return c.bestStreak >= 30; } },
    { id: 'streak-100', name: '百日筑基', desc: '连续打卡 100 天', icon: '百', tier: 'gold', check: function (c) { return c.bestStreak >= 100; } },

    { id: 'learn-10', name: '开卷有益', desc: '学完 10 个知识点', icon: '书', tier: 'bronze', check: function (c) { return c.learned >= 10; } },
    { id: 'learn-30', name: '半壁江山', desc: '学完 30 个知识点', icon: '半', tier: 'silver', check: function (c) { return c.learned >= 30; } },
    { id: 'learn-half', name: '过半', desc: '学完当前考纲一半的知识点', icon: '越', tier: 'silver', check: function (c) { return c.total > 0 && c.learned * 2 >= c.total; } },
    { id: 'learn-all', name: '全树点亮', desc: '学完全部知识点', icon: '全', tier: 'gold', check: function (c) { return c.total > 0 && c.learned >= c.total; } },

    { id: 'correct-50', name: '五十题', desc: '累计答对 50 题', icon: '五', tier: 'bronze', check: function (c) { return c.correct >= 50; } },
    { id: 'correct-200', name: '题海遨游', desc: '累计答对 200 题', icon: '海', tier: 'silver', check: function (c) { return c.correct >= 200; } },
    { id: 'correct-500', name: '千锤百炼', desc: '累计答对 500 题', icon: '千', tier: 'gold', check: function (c) { return c.correct >= 500; } },

    { id: 'combo-10', name: '十连对', desc: '单日连续答对 10 题', icon: '十', tier: 'bronze', check: function (c) { return c.bestCombo >= 10; } },
    { id: 'combo-25', name: '势不可挡', desc: '单日连续答对 25 题', icon: '势', tier: 'silver', check: function (c) { return c.bestCombo >= 25; } },
    { id: 'combo-50', name: '无人能挡', desc: '单日连续答对 50 题', icon: '极', tier: 'gold', check: function (c) { return c.bestCombo >= 50; } },

    { id: 'queue-clear', name: '队列清零', desc: '清空一次到期的复习队列', icon: '清', tier: 'bronze', check: function (c) { return !!c.flags.clearedQueue; } },
    { id: 'mistake-zero', name: '错题清仓', desc: '答对过至少 5 题，且错题本已经清空', icon: '仓', tier: 'silver', check: function (c) { return c.correct >= 5 && c.mistakes === 0; } },
    { id: 'focus-120', name: '深度专注', desc: '单日专注满 120 分钟', icon: '专', tier: 'silver', check: function (c) { return c.maxMinutes >= 120; } },
    { id: 'deck-20', name: '卡片收藏家', desc: '卡片库攒够 20 张', icon: '卡', tier: 'bronze', check: function (c) { return c.deckCards >= 20; } },

    { id: 'chapter-1', name: '首章通关', desc: '点亮第一个章节', icon: '首', tier: 'bronze', check: function (c) { return c.chaptersDone >= 1; } },
    { id: 'chapter-5', name: '攻城略地', desc: '点亮 5 个章节', icon: '攻', tier: 'silver', check: function (c) { return c.chaptersDone >= 5; } },
    { id: 'chapter-all', name: '一统天下', desc: '点亮全部章节', icon: '统', tier: 'gold', check: function (c) { return c.chaptersTotal > 0 && c.chaptersDone >= c.chaptersTotal; } },

    { id: 'boss-1', name: '初战告捷', desc: '通关第一个章节 BOSS', icon: '捷', tier: 'silver', check: function (c) { return c.bossPassed >= 1; } },
    { id: 'boss-3', name: '屠龙者', desc: '通关 3 个章节 BOSS', icon: '屠', tier: 'gold', check: function (c) { return c.bossPassed >= 3; } },

    { id: 'level-5', name: '登堂入室', desc: '升到 5 级', icon: '堂', tier: 'bronze', check: function (c) { return c.level >= 5; } },
    { id: 'level-10', name: '渐入佳境', desc: '升到 10 级', icon: '境', tier: 'gold', check: function (c) { return c.level >= 10; } }
  ];

  /* 判定所有成就，把新解锁的写进 state.game.achievements，返回新解锁的 id 列表。
   * 返回数组而不是布尔 —— 调用方要拿它弹提示。 */
  function checkAchievements(state, world, opts) {
    var g = ensure(state);
    var ctx = snapshot(state, world, opts);
    var fresh = [];
    ACHIEVEMENTS.forEach(function (a) {
      if (g.achievements[a.id]) return;
      var hit = false;
      try { hit = !!a.check(ctx); } catch (e) { hit = false; }
      if (!hit) return;
      g.achievements[a.id] = ctx.today;
      fresh.push(a.id);
    });
    return fresh;
  }

  function byId(id) {
    for (var i = 0; i < ACHIEVEMENTS.length; i++) if (ACHIEVEMENTS[i].id === id) return ACHIEVEMENTS[i];
    return null;
  }

  /* 成就墙用：带上解锁日期与"离解锁还差多少" */
  function achievementBoard(state, world, opts) {
    var g = ensure(state);
    var ctx = snapshot(state, world, opts);
    return ACHIEVEMENTS.map(function (a) {
      var at = g.achievements[a.id] || null;
      return {
        id: a.id, name: a.name, desc: a.desc, icon: a.icon, tier: a.tier,
        unlocked: !!at, date: at,
        progress: a.progress ? a.progress(ctx) : null
      };
    });
  }

  /* ---------- 章节进度 / 点亮 ---------- */
  function chapterProgress(state, world, opts) {
    state = state || {};
    world = world || defaultWorld();
    opts = opts || {};
    var track = opts.track || 'math1';
    var g = ensure(state);
    var cards = state.cards || {};
    var out = [];
    world.chapters.forEach(function (ch) {
      var nodes = world.nodes.filter(function (n) {
        return n.chapterId === ch.id && inTrack(n, track);
      });
      if (!nodes.length) return;
      var mastered = nodes.filter(function (n) { return cards[n.id]; }).length;
      var boss = g.boss[ch.id] || null;
      out.push({
        id: ch.id, name: ch.name, categoryId: ch.categoryId,
        categoryName: ch.categoryName, color: ch.color,
        total: nodes.length, mastered: mastered,
        done: mastered >= nodes.length,
        pct: Math.round(mastered / nodes.length * 100),
        bossUnlocked: mastered >= nodes.length,
        bossPassed: !!(boss && boss.score != null),
        bossScore: boss ? boss.score : null,
        bossTotal: boss ? boss.total : null
      });
    });
    return out;
  }

  /* ---------- BOSS 卷 ---------- */
  var BOSS_PASS_RATIO = 0.7;   // 正确率 ≥ 70% 通关

  /* 抽题：优先抽本章节点下的题；不够就退回该分类下的题。
   * 用确定性排序（按 id）而不是随机 —— 同一章每次抽到的题一样，
   * 便于"上次错哪几道"的复现，也便于测试。 */
  function bossQuestions(world, chapterId, n) {
    world = world || defaultWorld();
    n = n || 8;
    var ch = null;
    world.chapters.forEach(function (c) { if (c.id === chapterId) ch = c; });
    if (!ch) return [];
    var inCh = {}, inCat = {};
    world.nodes.forEach(function (nd) {
      if (nd.chapterId === chapterId) inCh[nd.id] = 1;
      if (nd.categoryId === ch.categoryId) inCat[nd.id] = 1;
    });
    var pick = function (set) {
      return world.questions
        .filter(function (q) { return set[q.kid]; })
        .map(function (q) { return q.id; })
        .sort();
    };
    var qs = pick(inCh);
    if (qs.length < n) {
      var extra = pick(inCat).filter(function (id) { return qs.indexOf(id) < 0; });
      qs = qs.concat(extra);
    }
    return qs.slice(0, n);
  }

  function bossResult(correct, total) {
    var ratio = total > 0 ? correct / total : 0;
    return {
      correct: correct, total: total,
      ratio: ratio,
      passed: ratio >= BOSS_PASS_RATIO,
      passRatio: BOSS_PASS_RATIO,
      pct: Math.round(ratio * 100)
    };
  }

  /* 记录一次 BOSS 成绩。只有更好的成绩才覆盖 —— 免得重刷一次手滑把纪录洗掉。 */
  function recordBoss(state, chapterId, correct, total, today) {
    var g = ensure(state);
    var r = bossResult(correct, total);
    var old = g.boss[chapterId];
    if (!old || correct > (old.score || 0)) {
      g.boss[chapterId] = { score: correct, total: total, date: today || fmtToday() };
    }
    return r;
  }

  /* ---------- 小工具 ---------- */
  function fmtToday() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function pad(n) { return ('0' + n).slice(-2); }

  /* 给 UI 用：等级表（含每级起始 XP），用于成就墙的进度条刻度 */
  function levelTable(upTo) {
    var n = upTo || 12, out = [], base = 0;
    for (var i = 1; i <= n; i++) {
      var need = needFor(i);
      out.push({ level: i, title: LEVELS[i - 1] || TOP_TITLE, from: base, to: base + need });
      base += need;
    }
    return out;
  }

  return {
    XP: XP,
    LEVELS: LEVELS,
    COMBO_MILESTONES: COMBO_MILESTONES,
    BOSS_PASS_RATIO: BOSS_PASS_RATIO,

    needFor: needFor,
    levelInfo: levelInfo,
    levelTable: levelTable,

    blank: blank,
    ensure: ensure,
    award: award,
    comboHit: comboHit,

    defaultWorld: defaultWorld,
    inTrack: inTrack,
    snapshot: snapshot,
    streakInfo: streakInfo,
    shiftDay: shiftDay,

    ACHIEVEMENTS: ACHIEVEMENTS,
    byId: byId,
    checkAchievements: checkAchievements,
    achievementBoard: achievementBoard,

    chapterProgress: chapterProgress,
    bossQuestions: bossQuestions,
    bossResult: bossResult,
    recordBoss: recordBoss,

    fmtToday: fmtToday
  };
})();
