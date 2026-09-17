/* 卡片引擎回归测试
   重点不是"函数没报错"，而是：
   1) 蒸馏出来的卡片**确实来自讨论内容**，不是套模板
   2) 去重 / 限量真的生效（同一张卡生成两次不会变两条）
   3) 模型返回的 JSON 坏掉时**退回本地抽取**，不炸
   4) 打印 HTML 的转义与公式渲染正确
*/
'use strict';
const path = require('path');
const BASE = path.join(__dirname, '..');

global.window = {};
require(path.join(BASE, 'js/cards.js'));
const Cards = global.window.Cards;

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  => ' + JSON.stringify(extra).slice(0, 200) : '')); }
}
function eq(a, b, label) { ok(a === b, label, { got: a, want: b }); }
function has(s, sub, label) { ok(String(s).indexOf(sub) >= 0, label, { got: String(s).slice(0, 160) }); }
function notHas(s, sub, label) { ok(String(s).indexOf(sub) < 0, label, { got: String(s).slice(0, 160) }); }

const NODE = { id: 'c1n4', title: '无穷小与等价代换' };

/* 一段编造的、但结构真实的课堂记录 */
const SESSION = {
  kid: 'c1n4', mode: 'lesson', stage: 'done',
  question: {
    id: 'q1', kid: 'c1n4', type: 'choice',
    stem: '求极限 lim (tan x - sin x) / x^3',
    options: [{ k: 'A', t: '1/2' }, { k: 'B', t: '0' }],
    answer: 'A',
    analysis: 'tan x - sin x 等价于 x^3/2，所以极限是 $1/2$。'
  },
  reason: '你在这一节错过 3 次',
  turns: [
    { role: 'teacher', text: '这一步讲完了。当 x 趋于 0 时，sin x 等价于 x。' },
    { role: 'smart', text: '我直接看比值就行，$\\lim_{x\\to 0}\\frac{\\sin x}{x}=1$，这是 1/2。' },
    { role: 'average', text: '那为什么不能拆开代换呢？加减里代换不是也可以吗？' },
    { role: 'weak', text: '我觉得是 0 吧，两个都换成 x 就减没了。' },
    { role: 'teacher', text: '学生丙把等价代换当成了普通约分，这是典型混淆。加减中不能随便代换，只有乘除因子才能换。' },
    { role: 'teacher', text: '这节课记住三件事：\n1. 等价代换只能用于乘除因子，加减中慎用。\n2. sin x 等价于 x，1-cos x 等价于 x^2/2。\n3. 遇到 tan x - sin x 要先提取公因式。\n注意：$\\lim_{x\\to 0}\\frac{1-\\cos x}{x^2}=\\frac{1}{2}$，这个结论要背下来。' }
  ],
  board: [{ by: 'smart', expr: '\\frac{\\sin x}{x}', svg: '<svg></svg>' }]
};

console.log('\n=== 1. 文本切分 ===');
const ss = Cards.splitSentences('第一句。第二句！第三句？\n第四句');
eq(ss.length, 4, '按句末标点与换行切成了 4 句');
eq(ss[0], '第一句。', '保留了句末标点');
eq(Cards.splitSentences('').length, 0, '空串安全');

const li = Cards.extractListItems('记住：\n1. 第一条要点内容\n2. 第二条要点内容\n③ 第三条要点内容');
eq(li.length, 3, '抽出了 3 条列表项', li);
eq(li[0], '第一条要点内容', '去掉了编号前缀');
eq(li[2], '第三条要点内容', '圆圈数字也认');

eq(Cards.extractListItems('极限是 0.5 和 3.14').length, 0, '★ 小数不会被误判成列表编号');
eq(Cards.cleanText('  **加粗**  '), '加粗', '去掉 markdown 加粗标记');
eq(Cards.cleanText('- 项目符号'), '项目符号', '去掉行首项目符号');
eq(Cards.cleanText('1. 编号项'), '编号项', '去掉行首编号');

console.log('\n=== 2. normalize：去空 / 去重 / 限量 / 排序 ===');
const meta = { kid: 'c1n4', kidTitle: '无穷小与等价代换' };
const n1 = Cards.normalize([
  { type: 'point', title: 'A', front: '内容一' },
  { type: 'point', title: 'B', front: '内容一' },          // 同 front → 去重
  { type: 'point', title: 'C', front: '   ' },             // 空 → 丢
  { type: 'bogus', title: 'D', front: '未知类型' }         // 类型兜底成 point
], meta);
eq(n1.length, 2, '去掉了重复与空卡', n1.map(c => c.front));
eq(n1[0].type, 'point', '未知类型兜底为 point');
eq(n1[0].kid, 'c1n4', 'meta 已注入');
ok(n1[0].id && n1[0].id.indexOf('point-') === 0, 'id 带类型前缀');

const many = [];
for (let i = 0; i < 12; i++) many.push({ type: 'point', title: 't' + i, front: '第 ' + i + ' 条不同的内容' });
const n2 = Cards.normalize(many, meta);
eq(n2.length, Cards.MAX_PER_TYPE.point, '★ 按类型限量（结论最多 ' + Cards.MAX_PER_TYPE.point + ' 张）');

const mixed = Cards.normalize([
  { type: 'formula', front: '$x^2$' },
  { type: 'problem', front: '题干' },
  { type: 'pitfall', front: '易错' },
  { type: 'point', front: '结论' }
], meta);
eq(mixed[0].type, 'problem', '排序：题目在最前');
eq(mixed[1].type, 'point', '排序：结论第二');
eq(mixed[mixed.length - 1].type, 'formula', '排序：公式在最后');

console.log('\n=== 3. merge：合并去重 ===');
const a = Cards.normalize([{ type: 'point', front: '共同的结论' }, { type: 'point', front: '只有旧的' }], meta);
const b = Cards.normalize([{ type: 'point', front: '共同的结论' }, { type: 'point', front: '只有新的' }], meta);
const m = Cards.merge(a, b);
eq(m.length, 3, '★ 重复的只留一份', m.map(c => c.front));
ok(m.some(c => c.front === '只有新的'), '新的加进来了');

console.log('\n=== 4. distill：从真实讨论里蒸馏 ===');
const cards = Cards.distill(SESSION, NODE);
const byType = Cards.countByType(cards);
ok(cards.length >= 5, '至少出了 5 张卡', cards.length);

const prob = cards.filter(c => c.type === 'problem')[0];
ok(!!prob, '出了题目卡');
has(prob.front, 'tan x - sin x', '题目卡的正面是题干');
has(prob.back, '答案：A', '题目卡背面有答案');
has(prob.back, '1/2', '题目卡背面有解析');

const points = cards.filter(c => c.type === 'point');
ok(points.length >= 3, '★ 从编号列表里抽出了多条结论', points.length);
has(points.map(c => c.front).join('|'), '只能用于乘除因子', '抽到了第 1 条结论');
has(points.map(c => c.front).join('|'), '提取公因式', '抽到了第 3 条结论');
notHas(points.map(c => c.front).join('|'), '1. ', '★ 结论里没有残留的编号前缀');

const pits = cards.filter(c => c.type === 'pitfall');
ok(pits.length >= 1, '出了易错卡');
has(pits.map(c => c.title).join('|'), '学生丙', '★ 易错卡点名到了丙');
has(pits.map(c => c.front).join('|'), '混淆', '易错卡的正面是老师的点评原句');

const ques = cards.filter(c => c.type === 'question');
ok(ques.length >= 1, '出了疑问卡');
has(ques[0].front, '为什么不能拆开代换', '疑问卡的正面是学生的问句');
has(ques[0].back, '学生丙', '★ 疑问卡的背面是老师随后的回应');

const forms = cards.filter(c => c.type === 'formula');
ok(forms.length >= 2, '出了公式卡', forms.length);
has(forms.map(c => c.front).join('|'), '\\frac{1-\\cos x}{x^2}', '抽到了老师讲的公式');
has(forms.map(c => c.front).join('|'), '\\frac{\\sin x}{x}', '★ 黑板上的公式也进来了');

console.log('\n=== 4b. ★ 公式卡不该把正文里的数学碎片也挖出来 ===');
// 这段数据里 $...$ 大量用于行内数学（"$\sin x$ 等价于 $x$"），
// 不加闸的话一节课能挖出五张垃圾公式卡 —— 这是截图看出来的真问题。
eq(Cards.isFormulaLike('x^3/2'), false, 'x^3/2 是碎片，不是公式');
eq(Cards.isFormulaLike('1/2'), false, '1/2 是碎片，不是公式');
eq(Cards.isFormulaLike('\\sin x'), false, '\\sin x 是碎片，不是公式');
eq(Cards.isFormulaLike('1-\\cos x'), false, '1-\\cos x 是碎片，不是公式');
eq(Cards.isFormulaLike('x'), false, '单个符号更不是');
eq(Cards.isFormulaLike('\\lim_{x\\to 0}\\frac{\\sin x}{x}=1'), true, '带等号的极限式是公式');
eq(Cards.isFormulaLike('\\lim_{x\\to\\infty}(1+\\frac{1}{x})^x=e'), true, '第二个重要极限是公式');
eq(Cards.isFormulaLike('\\int_0^1 x^2\\,dx'), true, '积分式是公式');
// 下面这两条是截图复查时翻案的真 bug：$1^{\infty}$ 只由一个数字、一个上标和一个
// 「符号」组成，它不是公式，是个未定式标记。早期版本把 \infty 归进结构命令，
// 于是它被做成公式卡，注解句还跟同一节课的易错点卡一字不差。
eq(Cards.isFormulaLike('1^\\infty'), false, '★ 1^∞ 是未定式标记，不是公式');
eq(Cards.isFormulaLike('1^{\\infty}'), false, '★ 带花括号的 1^{∞} 也不该漏过去（长度阈值拦不住它）');
eq(Cards.isFormulaLike('\\frac{1}{2}'), false, '★ 光一个分数不算公式 —— 剥掉命令后没有变量');
eq(Cards.isFormulaLike('\\sqrt{2}'), false, '光一个根号也不算');
eq(Cards.isFormulaLike('\\lim_{x\\to\\infty}\\left(1+\\frac{1}{x}\\right)^x'), true,
  '没有等号，但含 \\lim 和变量，仍算公式');

ok(!cards.some(c => c.type === 'formula' && c.front === '$1/2$'),
  '★ 题目解析里的 $1/2$ 没有变成公式卡');
ok(!cards.some(c => c.type === 'formula' && c.front === '$x^3/2$'),
  '★ 也没有 $x^3/2$');
ok(forms.every(c => c.back && c.back.length > 0), '★ 每张公式卡都带上了它出现的那句话');

// 原句如果除了公式本身没别的信息，就不该放背面（正反面同一句话是浪费纸）
const bare = Cards.distill({
  kid: 'c1n4',
  turns: [{ role: 'teacher', text: '$\\int_0^1 x^2\\,dx$' }]
}, NODE);
const bareForm = bare.filter(c => c.type === 'formula')[0];
ok(bareForm && !bareForm.back, '★ 原句只有公式时，背面留空而不是复读一遍');

console.log('\n=== 4c. latexFragments 带上下文 ===');
const frags = Cards.latexFragments('记住：$\\lim_{x\\to 0}\\frac{\\sin x}{x}=1$，这个很重要。');
eq(frags.length, 1, '抽到 1 个片段');
eq(frags[0].tex, '\\lim_{x\\to 0}\\frac{\\sin x}{x}=1', 'tex 正确');
has(frags[0].context, '这个很重要', '★ 带上了它所在的那句话');

console.log('\n=== 4d. ★ 背面不该复读别的卡的正面 ===');
// 同一句话常被抽中两次：一次当易错点（正面），一次当公式卡的注解（背面）。
// 印在纸上就是同一句话出现两遍。$1^{\infty}$ 那张卡正是这么来的 ——
// 截图里它跟旁边的「易错 · 学生丙」一字不差。
const dup = Cards.distill({
  kid: 'c1n4',
  turns: [
    { role: 'teacher', text: '学生丙忽略了 $1^{\\infty}$ 是未定式，不能直接把底数代入。' },
    { role: 'teacher', text: '记住：$\\lim_{x\\to\\infty}(1+\\frac{1}{x})^x=e$，这就是第二个重要极限。' }
  ]
}, NODE);
ok(!dup.some(c => c.type === 'formula' && c.front.indexOf('1^') >= 0),
  '★ 1^∞ 没有变成公式卡（它是标记，不是公式）');
const dupPit = dup.filter(c => c.type === 'pitfall')[0];
ok(!!dupPit, '那句话作为易错点留下来了');
has(dupPit ? dupPit.front : '', '未定式', '易错点的正面就是老师的原句');
has(dupPit ? dupPit.title : '', '学生丙', '易错点点名到了丙');
ok(dup.some(c => c.type === 'formula' && c.front.indexOf('重要极限') >= 0 || c.front.indexOf('=e') >= 0),
  '同一节课的真公式照样抽到了');

// 正面撞车时清空背面（而不是删卡）
const clash = Cards.normalize([
  { type: 'pitfall', front: '加减中不能随便代换' },
  { type: 'formula', front: '$\\lim_{x\\to 0}\\frac{\\sin x}{x}=1$', back: '加减中不能随便代换' }
], meta);
eq(clash.filter(c => c.type === 'formula')[0].back, '',
  '★ 公式卡背面跟别的卡正面是同一句时，背面清空');
eq(clash.length, 2, '卡本身都留着（清的是复读，不是删内容）');
eq(Cards.plainText('加减中不能随便代换。'), Cards.plainText('加减中，不能随便代换'),
  '比对时忽略标点差异');

console.log('\n=== 4e. ★ 整张卡就是公式清单时，别再拆成四张卡 ===');
// 「必记 2」如果整张就是三个等价无穷小，那这三个公式不该再各出一张公式卡 ——
// 同一句话变成四张卡，翻的时候会觉得这工具在凑数。
const listy = Cards.distill({
  kid: 'c1n4',
  turns: [{ role: 'teacher', text: '记住：\n1. 结论甲要背下来。\n2. $\\sin x\\sim x$，$\\tan x\\sim x$，$1-\\cos x\\sim \\frac{x^2}{2}$。' }]
}, NODE);
eq(listy.filter(c => c.type === 'formula').length, 0, '★ 清单里的公式没有再各出一张卡');
has(listy.map(c => c.front).join('|'), '\\tan x\\sim x', '清单本身作为结论卡留下了');

// 反向：带语境的结论卡，它提到的公式仍然该单独出一张
const ctxCard = Cards.distill({
  kid: 'c1n4',
  turns: [{ role: 'teacher', text: '记住：$\\lim_{x\\to\\infty}(1+\\frac{1}{x})^x=e$，这就是第二个重要极限。' }]
}, NODE);
ok(ctxCard.some(c => c.type === 'formula'),
  '★ 带语境的结论卡提到的公式，仍然单独出一张（别把清单规则误伤成「一律不拆」）');

console.log('\n=== 5. 重复蒸馏不产生重复卡 ===');
const again = Cards.distill(SESSION, NODE);
const merged = Cards.merge(cards, again);
eq(merged.length, cards.length, '★ 同一节课蒸馏两次，合并后数量不变');

console.log('\n=== 6. 空 / 残缺输入不炸 ===');
eq(Cards.distill({}, NODE).length, 0, '空 session 返回空数组');
eq(Cards.distill(null, null).length, 0, 'null 输入安全');
ok(Array.isArray(Cards.distill({ kid: 'c1n4', turns: [] }, NODE)), '只有 kid 也不炸');

console.log('\n=== 7. parseCards：模型输出容错 ===');
const good = Cards.parseCards(JSON.stringify([
  { type: 'pitfall', title: '加减不能代换', front: '两个都换成 x 就减没了', back: '加减中代换要先提取公因式' },
  { type: 'point', title: '等价代换条件', front: '只能用于乘除因子', back: '' }
]), meta);
ok(!!good && good.length === 2, '正常 JSON 解析出 2 张');
eq(good.filter(c => c.type === 'pitfall')[0].back, '加减中代换要先提取公因式', 'back 保住了');

const fenced = Cards.parseCards('```json\n[{"type":"point","front":"围栏里的内容"}]\n```', meta);
ok(!!fenced && fenced.length === 1, '★ 带 ``` 代码块围栏也能解析');

const chatty = Cards.parseCards('好的，我整理如下：\n[{"type":"point","front":"前后有废话"}]\n希望对你有帮助。', meta);
ok(!!chatty && chatty.length === 1, '★ 前后有解释文字也能抠出 JSON');

eq(Cards.parseCards('这不是 JSON', meta), null, '纯文本 → null');
eq(Cards.parseCards('[]', meta), null, '空数组 → null');
eq(Cards.parseCards('', meta), null, '空串 → null');
eq(Cards.parseCards('{"next":"x"}', meta), null, '对象而不是数组 → null');
eq(Cards.parseCards('[{"type":"point"}', meta), null, '截断的 JSON → null');

const badType = Cards.parseCards('[{"type":"乱写","front":"内容还在"}]', meta);
ok(!!badType && badType[0].type === 'point', '★ 类型乱写会兜底成 point，内容不丢');

const onlyBack = Cards.parseCards('[{"type":"point","back":"只有背面"}]', meta);
ok(!!onlyBack && onlyBack[0].front === '只有背面', '★ 只给了 back 时自动升为 front');

console.log('\n=== 8. aiMessages：喂给模型的提示 ===');
const msgs = Cards.aiMessages(SESSION, NODE);
eq(msgs.length, 2, 'system + user 两条');
has(msgs[0].content, 'JSON', 'system 要求输出 JSON');
has(msgs[0].content, 'pitfall', 'system 说明了卡片类型');
has(msgs[1].content, '无穷小与等价代换', 'user 带了考点名');
has(msgs[1].content, 'tan x - sin x', 'user 带了题目');
has(msgs[1].content, '学生丙', 'user 带了讨论记录');

console.log('\n=== 9. 打印 HTML ===');
const html = Cards.deckHtml(cards, { meta: { title: '课堂复习卡片', sub: '无穷小与等价代换', date: '2026-09-13' } });
has(html, 'pk-cover', '有封面块');
has(html, '无穷小与等价代换', '封面有考点名');
has(html, 'pk-card', '有卡片');
has(html, '--pk:' + Cards.TYPES.pitfall.color, '★ 易错卡带上了自己的类型色变量（' + Cards.TYPES.pitfall.color + '）');
eq((html.match(/class="pk-card/g) || []).length, cards.length, '卡片数量对得上');

const escaped = Cards.deckHtml([{ type: 'point', title: '<script>x</script>', front: 'a & b', back: '' }], {});
notHas(escaped, '<script>', '★ 标题里的 HTML 被转义了');
has(escaped, '&amp;', '★ & 被转义了');

const withRender = Cards.deckHtml(
  [{ type: 'formula', title: '公式', front: '$x^2$', back: '' }],
  { render: t => '<span class="katex">R[' + t + ']</span>' }
);
has(withRender, 'R[x^2]', '★ $...$ 交给了 render 函数');

const noRender = Cards.deckHtml([{ type: 'formula', title: '公式', front: '$x^2$', back: '' }], {});
has(noRender, 'pk-tex-raw', '没有 render 时退化成原文显示');

const standalone = Cards.standaloneHtml(cards, { meta: { title: '我的卡片' } });
has(standalone, '<!DOCTYPE html>', '独立 HTML 有 doctype');
has(standalone, 'pk-card', '独立 HTML 里有卡片');
has(standalone, '.pk-card{break-inside:avoid', '★ 独立 HTML 内联了打印样式（不依赖 style.css）');
has(standalone, '@page', '独立 HTML 有分页设置');
has(standalone, 'grid-template-columns:1fr 1fr', '独立 HTML 是两栏');
has(standalone, 'class="pk-deck"', '独立 HTML 有网格容器');

console.log('\n──────────────────────────────');
console.log((fail === 0 ? '✅ 卡片引擎全部通过：' : '❌ 有失败：') + pass + ' 项' + (fail ? '，失败 ' + fail : ''));
process.exit(fail ? 1 : 0);
