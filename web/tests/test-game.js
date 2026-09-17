/* 游戏化核心回归测试
 *
 * 重点不是"函数没报错"，而是：
 *   1) 等级曲线的边界（正好升、差一点、越级）
 *   2) XP 幂等 —— 同一件事重复触发不能刷分（这是最容易漏的漏洞）
 *   3) 成就只解锁一次，且判定用的是真实状态
 *   4) 章节点亮 / BOSS 解锁的口径（全章 mastered 才点亮）
 *   5) 坏存档不炸（缺字段、null、字符串乱入）
 */
'use strict';
const path = require('path');
const BASE = path.join(__dirname, '..');

global.window = {};
require(path.join(BASE, 'js/game.js'));
const Game = global.window.Game;

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  => ' + JSON.stringify(extra).slice(0, 200) : '')); }
}
function eq(a, b, label) { ok(a === b, label, { got: a, want: b }); }
function has(s, sub, label) { ok(String(s).indexOf(sub) >= 0, label, { got: String(s).slice(0, 160) }); }

/* ---------- 造一个可控的"世界"，不依赖真实题库 ---------- */
const WORLD = {
  chapters: [
    { id: 'calc-0', name: '第一章 极限', categoryId: 'calculus', categoryName: '高等数学', color: '#3b5bdb' },
    { id: 'calc-1', name: '第二章 微分', categoryId: 'calculus', categoryName: '高等数学', color: '#3b5bdb' },
    { id: 'la-0', name: '第一章 行列式', categoryId: 'linear', categoryName: '线性代数', color: '#0f766e' }
  ],
  nodes: [
    { id: 'c1n1', title: '数列极限', exam: 'all', chapterId: 'calc-0', categoryId: 'calculus' },
    { id: 'c1n2', title: '重要极限一', exam: 'all', chapterId: 'calc-0', categoryId: 'calculus' },
    { id: 'c2n1', title: '导数定义', exam: 'all', chapterId: 'calc-1', categoryId: 'calculus' },
    { id: 'c2n2', title: '求导法则', exam: ['math1', 'math2'], chapterId: 'calc-1', categoryId: 'calculus' },
    { id: 'c2n3', title: '三阶导应用', exam: ['math1'], chapterId: 'calc-1', categoryId: 'calculus' },
    { id: 'l1n1', title: '行列式定义', exam: 'all', chapterId: 'la-0', categoryId: 'linear' }
  ],
  questions: [
    { id: 'q1', kid: 'c1n1' }, { id: 'q2', kid: 'c1n1' }, { id: 'q3', kid: 'c1n2' },
    { id: 'q4', kid: 'c2n1' }, { id: 'q5', kid: 'c2n2' },
    { id: 'q6', kid: 'l1n1' }
  ]
};
const OPT = { track: 'math1', today: '2026-09-13' };

console.log('=== 1. 等级曲线 ===');
eq(Game.levelInfo(0).level, 1, '0 XP 是 1 级');
eq(Game.levelInfo(0).title, '初识极限', '1 级有称号');
eq(Game.levelInfo(99).level, 1, '差 1 点还是 1 级');
eq(Game.levelInfo(100).level, 2, '★ 正好 100 点升到 2 级');
eq(Game.levelInfo(100).into, 0, '刚升级时本级进度归零');
eq(Game.levelInfo(259).level, 2, '2 级需要 100+160=260，259 还在 2 级');
eq(Game.levelInfo(260).level, 3, '★ 260 点升到 3 级');
eq(Game.levelInfo(0).need, 100, '1 级的 need 是 100');
eq(Game.levelInfo(100).need, 160, '2 级的 need 是 160（曲线递增）');
ok(Game.levelInfo(1000).level > Game.levelInfo(500).level, 'XP 越多等级越高');
eq(Game.levelInfo(999999).title, Game.LEVELS[Game.LEVELS.length - 1], '超出表长沿用最高称号');
ok(Game.levelInfo(-5).level === 1 && Game.levelInfo(-5).xp === 0, '负 XP 兜底为 0（坏存档不炸）');
eq(Game.levelInfo(150).pct, 31, '本级百分比按整数算');

const tbl = Game.levelTable(3);
eq(tbl.length, 3, '等级表长度正确');
eq(tbl[0].from, 0, '1 级从 0 开始');
eq(tbl[1].from, 100, '★ 2 级从 100 开始（跟 levelInfo 一致）');
eq(tbl[2].from, 260, '3 级从 260 开始');

console.log('\n=== 2. 发 XP 与幂等 ===');
let st = { game: Game.blank() };
const r1 = Game.award(st, 'learn', { key: 'learn:c1n4' });
eq(r1.gained, Game.XP.learn, '学一个知识点拿到 20 XP');
eq(st.game.xp, 20, 'XP 累加到了 state 上');
eq(r1.levelUp, false, '20 点还没升级');

const r2 = Game.award(st, 'learn', { key: 'learn:c1n4' });
eq(r2, null, '★ 同一个 key 再发一次返回 null');
eq(st.game.xp, 20, '★ 重复触发不刷分（这是最要紧的一条）');

Game.award(st, 'learn', { key: 'learn:c1n5' });
eq(st.game.xp, 40, '换个 key 正常累加');

// 一路加到 100，看跨线那一刻
let cross = null;
['c1n6', 'c1n7', 'c1n8'].forEach(function (k) { cross = Game.award(st, 'learn', { key: 'learn:' + k }); });
eq(st.game.xp, 100, '攒到 100');
eq(cross.levelUp, true, '★ 80→100 那一次被识别出升级（要抓跨线的那次，不是下一次）');
eq(cross.from, 1, '从 1 级');
eq(cross.to, 2, '升到 2 级');
eq(cross.title, '数轴新兵', '升级时带回称号');

const r6 = Game.award(st, 'learn', { key: 'learn:c1n9' });
eq(st.game.xp, 120, '120 XP');
eq(r6.levelUp, false, '★ 2 级内继续攒不会重复报升级');

// 没有 key 的动作可以重复得分（做题本来就该做一次得一次）
let st2 = { game: Game.blank() };
Game.award(st2, 'correct'); Game.award(st2, 'correct'); Game.award(st2, 'correct');
eq(st2.game.xp, 30, '★ 无 key 的动作（答题）可以反复得分');
eq(Game.award(st2, 'correct').gained, 10, '答对一次 10 分');

// 复习四档
let st3 = { game: Game.blank() };
Game.award(st3, 'review', { rating: 1 });
eq(st3.game.xp, 2, '忘了只给 2 分');
Game.award(st3, 'review', { rating: 4 });
eq(st3.game.xp, 12, '轻松给 10 分');
eq(Game.award(st3, 'review', { rating: 9 }), null, '非法档位不发分');
eq(Game.award(st3, '不存在的动作'), null, '★ 未知动作不发分（防手滑写错 kind 静默加分）');

console.log('\n=== 3. 连击 ===');
let st4 = { game: Game.blank() };
eq(Game.comboHit(st4, true).combo, 1, '答对连击 +1');
Game.comboHit(st4, true); Game.comboHit(st4, true);
eq(st4.game.combo, 3, '连击累计到 3');
eq(st4.game.bestCombo, 3, '最高连击同步记录');
eq(Game.comboHit(st4, false).combo, 0, '★ 答错清零');
eq(st4.game.bestCombo, 3, '★ 清零不动历史最高（成就要用它）');
eq(Game.comboHit(st4, true).combo, 1, '清零后重新开始');

let st5 = { game: Game.blank() };
let ms = null;
for (let i = 0; i < 10; i++) ms = Game.comboHit(st5, true).milestone;
eq(ms, 10, '★ 连对 10 次报出里程碑');
eq(Game.comboHit(st5, true).milestone, null, '第 11 次不重复报里程碑');

console.log('\n=== 4. 快照：口径要对得上 ===');
const SNAP_STATE = {
  game: Game.blank(),
  cards: { c1n1: {}, c1n2: {} },                 // 学完 2 个
  attempts: [
    { qid: 'q1', kid: 'c1n1', correct: true },
    { qid: 'q2', kid: 'c1n1', correct: false },   // 错题
    { qid: 'q3', kid: 'c1n2', correct: true },
    { qid: 'q3', kid: 'c1n2', correct: true }     // 同题再答一次
  ],
  checkins: { '2026-09-12': { minutes: 45 }, '2026-09-13': { minutes: 10 } },
  cardDeck: { c1n1: [{}, {}, {}], c1n2: [{}, {}] }
};
const snap = Game.snapshot(SNAP_STATE, WORLD, OPT);
eq(snap.learned, 2, '已学知识点数正确');
eq(snap.total, 6, '考纲内节点总数正确（math1 全含）');
eq(snap.correct, 3, '答对数按作答次数累计');
eq(snap.attempts, 4, '总作答次数');
eq(snap.mistakes, 1, '★ 错题数按"每题最后一次作答"算，不是按错误次数');
eq(snap.maxMinutes, 45, '★ 单日最长专注取历史最大值，不是今天');
eq(snap.deckCards, 5, '卡片库总数跨考点累加');
// c1n1 + c1n2 正好是 calc-0 的全部节点 → 这一章已经点亮
eq(snap.chaptersDone, 1, '★ 学完 c1n1+c1n2 就点亮了 calc-0 这一章');
eq(snap.chaptersTotal, 3, '总章节数 3');

// 考试范围过滤：数二不含 c2n3
const snapM2 = Game.snapshot(SNAP_STATE, WORLD, { track: 'math2', today: '2026-09-13' });
eq(snapM2.total, 5, '★ 切到数二后节点总数从 6 变 5（c2n3 被排除）');
eq(Game.inTrack({ exam: 'all' }, 'math2'), true, 'exam=all 的节点数二也要');
eq(Game.inTrack({ exam: ['math1'] }, 'math2'), false, '★ 仅数一的节点被数二排除');

console.log('\n=== 4b. 连续打卡天数：从 checkins 推导 ===');
// 不存字段、只算 —— 存字段最容易跟真实记录漂移
eq(Game.streakInfo({}, '2026-09-13').current, 0, '没打过卡是 0');
eq(Game.streakInfo({}, '2026-09-13').best, 0, '最长也是 0');

const ck = {
  '2026-09-10': { tasksDone: true },
  '2026-09-11': { minutes: 30 },          // 专注满 30 分钟也算打卡
  '2026-09-12': { tasksDone: true },
  '2026-09-13': { tasksDone: true },
  '2026-09-05': { minutes: 5 }            // 没满 30 也不算完成，不算打卡
};
eq(Game.streakInfo(ck, '2026-09-13').current, 4, '★ 连着 4 天（10~13）');
eq(Game.streakInfo(ck, '2026-09-13').best, 4, '最长也是 4');
eq(Game.streakInfo(ck, '2026-09-14').current, 4, '★ 今天还没打卡时，从昨天往回数（别把连续天数清零）');
eq(Game.streakInfo(ck, '2026-09-15').current, 0, '★ 断了两天才归零');

// 最长连续要能识别"中间断过、后面更长"
const ck2 = {
  '2026-09-01': { tasksDone: true },
  '2026-09-05': { tasksDone: true },
  '2026-09-06': { tasksDone: true },
  '2026-09-07': { tasksDone: true }
};
eq(Game.streakInfo(ck2, '2026-09-07').current, 3, '当前连续 3 天');
eq(Game.streakInfo(ck2, '2026-09-07').best, 3, '★ 最长取的是后面那一段 3 天，不是前面孤零零的 1 天');

// 跨月跨年
const ck3 = { '2026-12-31': { tasksDone: true }, '2027-01-01': { tasksDone: true } };
eq(Game.streakInfo(ck3, '2027-01-01').current, 2, '★ 跨年也能连上');
eq(Game.shiftDay('2026-03-01', -1), '2026-02-28', '日期回退跨月正确');
eq(Game.shiftDay('2024-03-01', -1), '2024-02-29', '★ 闰年 2 月 29 天');
eq(Game.shiftDay('乱七八糟', 1), '乱七八糟', '坏日期原样返回，不炸');

console.log('\n=== 5. 成就：只解锁一次 ===');
let st6 = { game: Game.blank(), cards: {}, attempts: [], checkins: { '2026-09-13': { tasksDone: true } } };
let fresh = Game.checkAchievements(st6, WORLD, OPT);
has(fresh.join(','), 'first-step', '★ 打卡解锁「万里长征第一步」');
eq(fresh.length, 1, '白板 + 一次打卡只解锁 1 个');

// 学 3 个（WORLD 里考纲内共 6 个）→ 正好一半，触发 learn-half
// 特意挑 c1n1 / c2n1 / c2n2：三章都差一个没满，这样不会顺带解锁章节成就，
// 断言才干净（用 c1n1+c1n2 会把 calc-0 凑满，多解锁一个 chapter-1）。
st6.cards = { c1n1: {}, c2n1: {}, c2n2: {} };
fresh = Game.checkAchievements(st6, WORLD, OPT);
has(fresh.join(','), 'learn-half', '★ 学满一半解锁「过半」');
ok(fresh.indexOf('learn-10') < 0, '★ 只学了 3 个，不该解锁「学完 10 个」（成就不放水）');
ok(fresh.indexOf('chapter-1') < 0, '★ 三章都没学满，不该解锁章节成就');
eq(fresh.length, 1, '这次正好解锁 1 个');

const again = Game.checkAchievements(st6, WORLD, OPT);
eq(again.length, 0, '★ 再判一次不会重复解锁（幂等）');
eq(st6.game.achievements['first-step'], '2026-09-13', '解锁日期记下来了');

const board = Game.achievementBoard(st6, WORLD, OPT);
eq(board.length, Game.ACHIEVEMENTS.length, '成就墙列出全部成就');
eq(board.filter(a => a.unlocked).length, 2, '已解锁 2 个（打卡 + 过半）');
eq(board.filter(a => !a.unlocked).length, Game.ACHIEVEMENTS.length - 2, '其余都是未解锁');
ok(board.every(a => a.name && a.desc && a.icon), '★ 每个成就都有名字、说明和图标（没漏写字段）');
ok(board.every(a => ['bronze', 'silver', 'gold'].indexOf(a.tier) >= 0), '★ 分级只有 bronze/silver/gold 三种');
const ids = Game.ACHIEVEMENTS.map(a => a.id);
eq(new Set(ids).size, ids.length, '★ 成就 id 不重复（重复会导致判定互相覆盖）');

// 全学完 → 全树点亮 + 一统天下（3 章都满）
st6.cards = { c1n1: {}, c1n2: {}, c2n1: {}, c2n2: {}, c2n3: {}, l1n1: {} };
const fin = Game.checkAchievements(st6, WORLD, OPT);
has(fin.join(','), 'learn-all', '★ 学完 6/6 解锁「全树点亮」');
has(fin.join(','), 'chapter-all', '★ 三章全满解锁「一统天下」');
has(fin.join(','), 'chapter-1', '★ 顺带解锁「首章通关」');
ok(fin.indexOf('mistake-zero') < 0,
  '★ 一题都没做过不给「错题清仓」（要答对过 5 题才算，白板不该白送）');
ok(fin.indexOf('chapter-5') < 0, '★ 只有 3 章，不该解锁「点亮 5 个章节」');
ok(fin.indexOf('boss-1') < 0, '★ 一章 BOSS 都没打，不该解锁 BOSS 成就');
ok(fin.indexOf('learn-30') < 0, '★ 只有 6 个知识点，不该解锁「学完 30 个」');

console.log('\n=== 6. 章节点亮 ===');
let st7 = { game: Game.blank(), cards: { c1n1: {} }, attempts: [] };
let chs = Game.chapterProgress(st7, WORLD, OPT);
const calc0 = chs.filter(c => c.id === 'calc-0')[0];
eq(calc0.total, 2, '第一章有 2 个节点');
eq(calc0.mastered, 1, '学了 1 个');
eq(calc0.done, false, '★ 没学完不算点亮');
eq(calc0.bossUnlocked, false, '★ 没点亮就锁着 BOSS');
eq(calc0.pct, 50, '进度百分比 50%');

st7.cards.c1n2 = {};
chs = Game.chapterProgress(st7, WORLD, OPT);
const calc0b = chs.filter(c => c.id === 'calc-0')[0];
eq(calc0b.done, true, '★ 全章 mastered 才点亮');
eq(calc0b.bossUnlocked, true, '★ 点亮后 BOSS 解锁');
eq(calc0b.pct, 100, '进度 100%');

const emptyCh = chs.filter(c => c.total > 0);
eq(emptyCh.length, 3, '三章都有节点（没把空章列出来）');

console.log('\n=== 7. BOSS 卷 ===');
const bq = Game.bossQuestions(WORLD, 'calc-0', 8);
// 本章只有 q1~q3 三题，不够 8 题 → 放宽到整个「高等数学」分类，补上 q4、q5，共 5 题
eq(bq.length, 5, '本章题目不够时自动放宽到整个分类');
eq(bq.join(','), 'q1,q2,q3,q4,q5', '★ 本章的题排在前面，补的题接在后面');
const bq2 = Game.bossQuestions(WORLD, 'calc-0', 8);
eq(bq.join(','), bq2.join(','), '★ 抽题是确定性的（同一章每次一样，便于复现错题）');
ok(bq.indexOf('q1') >= 0 && bq.indexOf('q2') >= 0 && bq.indexOf('q3') >= 0, '★ 本章的题一定在内');
eq(Game.bossQuestions(WORLD, '不存在', 8).length, 0, '不存在的章节返回空');
eq(Game.bossQuestions(WORLD, 'calc-1', 1).length, 1, '限 1 题就只给 1 题');

const rp = Game.bossResult(7, 10);
eq(rp.passed, true, '7/10 通关（≥70%）');
eq(rp.pct, 70, '百分比 70');
eq(Game.bossResult(6, 10).passed, false, '★ 6/10 不过（差一点也不放水）');
eq(Game.bossResult(0, 0).passed, false, '★ 0 题不发通过（防除零判成 NaN>=0.7）');
eq(Game.bossResult(0, 0).ratio, 0, '0 题时 ratio 兜底为 0');

let st8 = { game: Game.blank() };
Game.recordBoss(st8, 'calc-0', 5, 8, '2026-09-13');
eq(st8.game.boss['calc-0'].score, 5, '成绩记下来了');
Game.recordBoss(st8, 'calc-0', 3, 8, '2026-09-14');
eq(st8.game.boss['calc-0'].score, 5, '★ 更差的成绩不覆盖纪录');
Game.recordBoss(st8, 'calc-0', 8, 8, '2026-09-15');
eq(st8.game.boss['calc-0'].score, 8, '更好的成绩覆盖');
eq(st8.game.boss['calc-0'].date, '2026-09-15', '日期也跟着更新');

const chs8 = Game.chapterProgress({ game: st8.game, cards: { c1n1: {}, c1n2: {} }, attempts: [] }, WORLD, OPT);
const calc0c = chs8.filter(c => c.id === 'calc-0')[0];
eq(calc0c.bossPassed, true, 'BOSS 通关状态传到章节进度上');
eq(calc0c.bossScore, 8, '带回成绩');

console.log('\n=== 8. 坏存档不炸 ===');
ok(Game.ensure(null) && typeof Game.ensure(null).xp === 'number', 'null 也能补出骨架');
eq(Game.ensure({}).xp, 0, '空对象补出 0 XP');
eq(Game.ensure({ game: { xp: 'abc' } }).xp, 0, '★ xp 是字符串时兜底为 0');
eq(Game.ensure({ game: { xp: NaN } }).xp, 0, '★ xp 是 NaN 时兜底为 0');
eq(Game.ensure({ game: { xp: -50 } }).xp, -50, '负数原样保留（由 levelInfo 兜底）');
eq(Game.snapshot({}, WORLD, OPT).learned, 0, '空 state 的快照不炸');
eq(Game.snapshot(null, WORLD, OPT).total, 6, 'null state 也能出快照');
eq(Game.checkAchievements({}, WORLD, OPT).length, 0, '空 state 判成就返回空数组');
eq(Game.chapterProgress(null, WORLD, OPT).length, 3, 'null state 的章节进度不炸');
eq(Game.award({}, 'learn').gained, 20, '★ 没 game 字段时 award 自动补骨架再发分');

console.log('\n──────────────────────────────');
console.log((fail === 0 ? '✅ 游戏化核心全部通过：' : '❌ 有失败：') + pass + ' 项' + (fail ? '，失败 ' + fail : ''));
process.exit(fail ? 1 : 0);
