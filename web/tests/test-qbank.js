/* 题库页 web/js/qbank.js 的自测（规格：ADR-017）
 *
 * 覆盖四条硬接缝：
 *   ① **HTTP 出口唯一**：qbank.js 里不许出现 fetch / XMLHttpRequest（BOUNDARY §1）
 *   ② **接线**：index.html 里 qbank.js 排在 app.js 之前（路由要调它），且有 #nav-subjects 容器
 *   ③ **窄窗契约**：app.js 只暴露 MDShell 的四个成员；/s/*、/q/* 两条路由接上
 *   ④ 纯函数：题干预览把 LaTeX 还原成一行人话（卡片上不渲染公式，详情页才渲染）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..');
const QBANK = path.join(WEB, 'js', 'qbank.js');
const APP = path.join(WEB, 'js', 'app.js');
const INDEX = path.join(WEB, 'index.html');
const qbankSrc = fs.readFileSync(QBANK, 'utf8');
const appSrc = fs.readFileSync(APP, 'utf8');
const indexSrc = fs.readFileSync(INDEX, 'utf8');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '  ' + extra : '')); }
}

console.log('\n=== web/js/qbank.js 题库浏览 ===');

// ① 唯一 HTTP 出口：本文件不许自己发请求（全站只有 api.js 能发）
{
  // 先剥注释再扫 —— 否则"本文件不许出现 fetch"这句注释自己会把检查判红（假红）。
  const code = qbankSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const noFetch = !/\bfetch\s*\(/.test(code);
  const noXhr = !/XMLHttpRequest/.test(code);
  ok('qbank.js 不直接 fetch', noFetch);
  ok('qbank.js 不碰 XMLHttpRequest', noXhr);
  ok('qbank.js 只经 MDStore 取数', /api\(\)\.qbank(List|Detail)\(/.test(qbankSrc));
}

// ② 接线：脚本顺序 + 侧栏容器
{
  const iQbank = indexSrc.indexOf('js/qbank.js');
  const iApp = indexSrc.indexOf('js/app.js');
  ok('index.html 载入 qbank.js', iQbank > 0);
  ok('qbank.js 排在 app.js 之前（app.js 的 route() 要调它）', iQbank > 0 && iQbank < iApp);
  ok('index.html 有 #nav-subjects 容器', /id="nav-subjects"/.test(indexSrc));
}

// ③ 窄窗契约：MDShell 的成员集合是**写死的四个**（多开一个都要改这条断言）
{
  const m = appSrc.match(/window\.MDShell\s*=\s*\{([^}]*)\}/);
  ok('app.js 暴露 window.MDShell', !!m);
  if (m) {
    const members = m[1].split(',').map(s => s.split(':')[0].trim()).filter(Boolean).sort();
    ok('MDShell 恰好四个成员（esc/md/head/toast）',
       JSON.stringify(members) === JSON.stringify(['esc', 'head', 'md', 'toast']),
       JSON.stringify(members));
  }
  ok('/s/<学科> 路由接上', /h\.match\(\/\^\\\/s\\\/\(\.\+\)\$\/\)/.test(appSrc));
  ok('/s/<学科>/<章> 两级路由接上（先题目类型、再题目）',
     /h\.match\(\/\^\\\/s\\\/\(\[\^\/\]\+\)\\\/\(\.\+\)\$\/\)/.test(appSrc));
  ok('/q/<题号> 路由接上', /h\.match\(\/\^\\\/q\\\/\(\.\+\)\$\/\)/.test(appSrc));
  ok('题库栏目高亮交给 qbank 自己判（不让 setActiveNav 先点亮仪表盘）',
     /if \(seg === 's' \|\| seg === 'q'\) return;/.test(appSrc));
}

// ④ 在 vm 里真加载一次 —— 顺带验纯函数与导出面
{
  const win = { KDATA: { categories: [
    { id: 'calculus', name: '高等数学', color: '#1b4d8f' },
    { id: 'linear', name: '线性代数', color: '#2f6b4f' }
  ] } };
  const ctx = vm.createContext({ window: win, document: {}, Promise, JSON, String, Math, console });
  vm.runInContext(qbankSrc, ctx, { filename: QBANK });
  const qb = win.MDQbank;
  ok('导出面：pageSubject / pageChapter / pageQuestion / loadSubjects',
     !!(qb && qb.pageSubject && qb.pageChapter && qb.pageQuestion && qb.loadSubjects));
  ok('栏目页按服务端的 groups（题目类型）渲染，不在前端自己分组',
     /d\.groups/.test(qbankSrc) && !/subject\s*===?\s*'linear'/.test(qbankSrc));
  // ⚠️ 2026-10-07：原来是「qbankList({subject, chapter…」内联对象形状；加筛选后改成先建 params 再加
  // 条件字段，故断言放宽到"参数对象里 subject 与 chapter 必须相邻出现"——原意（不能漏传 chapter）不变。
  ok('类型页把 chapter 传给服务端（漏了这一步 = 空类型会串到别的类型）',
     /subject:\s*subject,\s*chapter:\s*chapter/.test(qbankSrc));
  ok('筛选参数挂在同一份 params 上（未做 ⇒ done=false；做错 ⇒ wrong=true）',
     /params\.done\s*=\s*false/.test(qbankSrc) && /params\.wrong\s*=\s*true/.test(qbankSrc));
  // 复核 S2 的"半格"：上面只钉住字段被设置，把 qbankList(params) 换成 qbankList() 仍会绿 ⇒ 补这一行锚
  ok('params 真的被传出去（不是设了字段却用空参请求）', /qbankList\(params\)/.test(qbankSrc));
  ok('难度来源标记：agent 评过的题要标出来', /difficultySource === 'agent'/.test(qbankSrc)
     && /agent 评/.test(qbankSrc));
  ok('学科中文名从知识树取（不在 qbank.js 里另立一套）',
     qb.subjectName('calculus') === '高等数学' && qb.subjectName('linear') === '线性代数');
  ok('树外学科有兜底名', qb.subjectName('probability') === '概率论与数理统计');
  const p = qb._preview('求 $\\lim_{x\\to 0}\\frac{\\sin 2x}{\\sin 5x}$ 的值');
  ok('题干预览：去掉 $ 与 LaTeX 命令，留一行人话',
     p.indexOf('$') < 0 && p.indexOf('\\') < 0 && p.indexOf('sin 2x') >= 0, JSON.stringify(p));
}

console.log('');
if (fail) {
  console.log('❌ 有失败：' + (pass + fail) + ' 项，失败 ' + fail);
  process.exit(1);
}
console.log('✅ 全部通过：' + pass + ' 项');
