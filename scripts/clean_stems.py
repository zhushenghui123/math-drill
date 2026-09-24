"""scripts/clean_stems.py —— 语料题面/解析的**确定性清洗**（不调模型，只照清单删/替换）。

为什么需要（2026-09-24 实测，生产库 6120 题）：OCR 把**页眉/水印/表格标签/数学标记**并进了正文。
每一类都有实测计数与样本（下面每条规则都对应真实形态，不靠猜）：

  1. **`<eq>…</eq>`**（MinerU 的行内数学标记，2418 处）：前端 `web/js/app.js` 只认 `$…$` 与裸 LaTeX，
     不认 `<eq>` —— 它被 `esc()` 转义后**原样显示成标签**（69 个题面 + 121 条解析可见）。
     ⇒ 转成 `$…$`（含换行的转 `$$…$$`，因为行内 `$` 不跨行）。
  2. **HTML 表格标签**（`<td>` 16888 / `<tr>` 2756 / `<table>` 768）：同样被转义后原样显示。
     ⇒ 单元格之间留 ` | `、行之间留换行，**不能直接删标签**（删了会把 `0.1|0.6|0.3` 揉成 `0.10.60.3`，比原样更糟）。
     ⚠️ 标签必须**用固定白名单**匹配：语料里有 `i<n`、`x<y` 这种数学，泛化的 `</?[A-Za-z]` 会把公式删坏（实测 20+ 处）。
  3. **扫描水印**（196 处上下文）：`公众号:考研拼课` / `公众号：考研讲课` …
     OCR 把水印与**紧随的页码/章节标题**粘在一起（`公众号:考研讲课185第四章 不定积分`）。
  4. **页眉被并进正文**（`<页码><第X章 章名>§N 节名`）：实测 1228 处，形如
     `计算曲面积分353吉米多维奇高等数学习题精选精解`、`…可见30第一章随机事件及其概率§6.综合提高`。
  5. **`[NO TEXT]`**（OCR 空内容占位，386 处）与零星乱码（`周理`/`天宁大`）。
  6. **`$` 配对不平衡**（**防御性规则，本轮实测 0 次命中**）：9 本书 13494 个字段里 `$` 出现 **0 次**
     —— 语料的公式全是裸 LaTeX，由前端 `autoLatex` 现包。规则保留是因为零成本，一旦将来有来源带 `$`
     （手工录入、别的引擎）就用得上：整条剥 `$` 交给 `autoLatex`，比留一个孤立 `$` 把后半段公式挤出数学模式要好。
     ⚠️ 我在 09-24 上一轮自查里报过「29 题渲染坏、根因是 `$` 不平衡」——**本轮复现不出来，该数字已撤回**
     （见 DATA_PIPELINE §10 末尾）。

纪律：**照清单删**（章名/节名/书名的白名单来自语料 `full.md` 的标题与实测抽串），
不做语义判断；改动记进 `q["flags"]`，原文备份 `.pre-clean.json` 可回溯。

用法：
    python3 scripts/clean_stems.py --candidates 'data/candidates/*.hybrid.kpid.json' --dry-run
    python3 scripts/clean_stems.py --candidates 'data/candidates/*.hybrid.kpid.json'
"""

from __future__ import annotations

import argparse
import glob
import json
import re
import shutil
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

__all__ = ["RULES", "clean_text", "clean_stem", "clean_bank"]

#: 章名白名单 —— **机械生成**，不是手抄：取自 9 本书 `full.md` 里 `# 第X章 <名>` 形式的标题（39 条）。
#: ⚠️ 手抄过一版，漏了 `向量代数与空间解析几何`，结果 `33第八章 向量代数与空间解析几何` 只被删掉前半
#: （`向量` 这个更短的条目先命中）⇒ **白名单必须整表生成、整表核对**（见 tests/test_clean_stems.py）。
CHAPTERS = [
    'bootstrap 方法',
    '不定积分',
    '二次型',
    '假设检验',
    '函数与极限',
    '参数估计',
    '向量',
    '向量代数与空间解析几何',
    '在数理统计中应用 EXCEL 软件',
    '多元函数微分法及其应用',
    '多维随机变量及其分布',
    '大数定律与中心极限定理',
    '大数定律及中心极限定理',
    '定积分',
    '定积分的应用',
    '导数与微分',
    '常微分方程',
    '平稳随机过程',
    '微分中值定理与导数的应用',
    '微分方程',
    '数理统计基本概念',
    '方差分析及回归分析',
    '无穷级数',
    '曲线积分与曲面积分',
    '极限与连续',
    '样本及抽样分布',
    '概率论的基本概念',
    '矩阵',
    '矩阵的特征值与特征向量',
    '线性方程组',
    '行 列 式',
    '选做习题',
    '重 积 分',
    '重积分',
    '随机事件及其概率',
    '随机变量及其分布',
    '随机变量的数字特征',
    '随机过程及其统计描述',
    '马尔可夫链',
]

#: 节名白名单 —— 同样机械生成：`full.md` 里 `# §N <名>` 形式的标题（55 条）。
SECTIONS = [
    'bootstrap 方法、宏、VBA',
    '一元线性回归',
    '一般周期函数的傅里叶级数',
    '一阶线性微分方程',
    '三重积分',
    '不定积分的概念与性质',
    '两个随机变量的函数的分布',
    '中心极限定理',
    '二维随机变量',
    '二重积分的概念与性质',
    '二重积分的计算法',
    '估计量的评选标准',
    '假设检验',
    '假设检验问题的 p 值法',
    '偏导数',
    '傅里叶级数',
    '全微分',
    '函数图形的描绘',
    '函数展开成幂级数',
    '函数的单调性与曲线的凹凸性',
    '函数的幂级数展开式的应用',
    '函数的微分',
    '函数的极值与最大值最小值',
    '函数的极限',
    '函数的求导法则',
    '函数的连续性与间断点',
    '函数项级数的一致收敛性及一致收敛级数的基本性质',
    '分布拟合检验',
    '分部积分法',
    '区间估计',
    '协方差及相关系数',
    '单侧置信区间',
    '单因素试验的方差分析',
    '参数 bootstrap 方法',
    '双因素试验的方差分析',
    '反常积分',
    '可分离变量的微分方程',
    '可降阶的高阶微分方程',
    '各态历经性',
    '向量及其线性运算',
    '在数理统计中应用Excel软件',
    '多元函数微分学的几何应用',
    '多元函数的基本概念',
    '多元函数的极值及其求法',
    '多元复合函数的求导法则',
    '多元线性回归',
    '多步转移概率的确定',
    '大数定律',
    '定积分在几何学上的应用',
    '定积分在物理学上的应用',
    '定积分的元素法',
    '定积分的换元法和分部积分法',
    '定积分的概念与性质',
    '对坐标的曲线积分',
    '对坐标的曲面积分',
    '对弧长的曲线积分',
    '对面积的曲面积分',
    '导数概念',
    '常数项级数的审敛法',
    '常数项级数的概念和性质',
    '常系数非齐次线性微分方程',
    '常系数齐次线性微分方程',
    '幂级数',
    '平稳随机过程的功率谱密度',
    '平稳随机过程的概念',
    '平面及其方程',
    '微分中值定理',
    '微分方程的基本概念',
    '微积分基本公式',
    '抽样分布',
    '换元积分法',
    '数列的极限',
    '数学期望',
    '数量积 向量积',
    '方 差',
    '方向导数与梯度',
    '方差分析',
    '方程的近似解',
    '无穷小与无穷大',
    '无穷小的比较',
    '映射与函数',
    '曲率',
    '曲面及其方程',
    '有理函数的积分',
    '条件分布',
    '条件概率',
    '极限存在准则 两个重要极限',
    '极限运算法则',
    '样本容量的选取',
    '样本空间、随机事件',
    '格林公式及其应用',
    '概述',
    '正态总体均值与方差的区间估计',
    '正态总体均值的假设检验',
    '正态总体方差的假设检验',
    '泊松过程及维纳过程',
    '泰勒公式',
    '洛必达法则',
    '点估计',
    '独立性',
    '直方图和箱线图',
    '相互独立的随机变量',
    '相关函数的性质',
    '矩、协方差矩阵',
    '离散型随机变量及其分布律',
    '积分表的使用',
    '空间曲线及其方程',
    '空间直线及其方程',
    '箱线图',
    '行列式',
    '边缘分布',
    '连续函数的运算与初等函数的连续性',
    '连续型随机变量及其概率密度',
    '迭做习题',
    '遍 历 性',
    '重积分的应用',
    '闭区间上连续函数的性质',
    '随机事件及其分布',
    '随机变量',
    '随机变量的函数的分布',
    '随机变量的分布函数',
    '随机样本',
    '随机试验',
    '随机过程的概念',
    '随机过程的统计描述',
    '隐函数及由参数方程所确定的函数的导数 相关变化率',
    '隐函数的求导公式',
    '非参数 bootstrap 方法',
    '频率与概率',
    '马尔可夫过程及其概率分布',
    '高斯公式',
    '高阶导数',
    '高阶线性微分方程',
    '齐次方程',
]

#: 书名的运行页眉（实测抽串，含并进正文的页眉）；允许字间空白抖动
BOOK_TITLES = [
    "一、《高等数学》(第七版)上册习题全解",
    "一、《高等数学》(第七版)下册习题全解",
    "一、《高等数学》（第七版）上册习题全解",
    "一、《高等数学》（第七版）下册习题全解",
    "《高等数学》(第七版)上册习题全解",
    "《高等数学》(第七版)下册习题全解",
    "高等数学习题全解指南",
    "高等数学 习题全解指南",
    "高等数学习题精选精解",
    "吉米多维奇高等数学习题精选精解",
    "线性代数习题精选精解",
    "概率论与数理统计习题精选精解",
    "概率论与数理统计习题全解指南",
]


def _alt(items: list[str]) -> str:
    """把白名单拼成正则分支（长的优先，避免短的先命中），并允许字间空白。"""
    pats = []
    for x in sorted(set(items), key=len, reverse=True):
        esc = re.escape(x)
        esc = esc.replace(r"\ ", r"\s*")          # 允许空白抖动 / 全角空格
        esc = esc.replace(r"（", r"[（(]").replace(r"）", r"[）)]")
        pats.append(esc)
    return "|".join(pats)


_CH = _alt(CHAPTERS)
_SEC = _alt(SECTIONS)
_TITLE = _alt(BOOK_TITLES)

#: 清洗规则（顺序敏感）。三元组 = (规则名, 正则, 替换)；替换可为字符串或 (match)->str。
RULES: list[tuple[str, re.Pattern[str], object]] = [
    ("no_text_marker", re.compile(r"\[NO TEXT\]"), ""),
    ("misc_artifact", re.compile(r"周理|天宁大"), ""),
    # ---- 1. 数学标记：<eq>…</eq> → $…$（跨行用 $$）
    ("eq_math", re.compile(r"<eq(?:\s[^>]*)?>(.*?)</eq>", re.S),
     lambda m: ("$$" + m.group(1).strip() + "$$") if "\n" in m.group(1)
     else ("$" + m.group(1).strip() + "$")),
    # ---- 2. 表格：先给分隔，再删残余标签（**不许直接删标签**，会粘连数字）
    ("table_cell", re.compile(r"</(?:td|th)\s*>"), " | "),
    ("table_row", re.compile(r"</tr\s*>"), "\n"),
    ("table_tag", re.compile(r"</?(?:table|tbody|thead|tfoot|tr|td|th|caption)\b[^>]*>"), ""),
    # ---- 3. 水印（公众号 + 紧随的错别字变体 + 粘连页码）
    ("watermark", re.compile(
        r"公众号\s*[:：]?\s*"
        r"(?:(?:考研|考协|考出|语文|请研|有研|语句|若如)[\u4e00-\u9fff]{0,4}(?:课|表|语|座)?"
        r"|(?:小结|习题|题|图)[\d.\-]{0,6}"
        r"|§\s*\d+(?:\.\d+)*)?"
        r"\s*\d{0,4}"), ""),
    # ---- 4. 页眉：<页码> + 第X章/节 + 章名/节名 (+ §N + 节名)
    ("page_header", re.compile(
        r"\d{1,4}\s*第[一二三四五六七八九十]{1,3}[章节][、·\s]*(?:" + _CH + r"|" + _SEC + r")"
        r"(?:\s*§\s*\d+(?:\.\d+)*\.?\s*(?:" + _SEC + r")?)?\s*\d{0,4}"), ""),
    # ---- 5. 孤立的 §N + 节名（前面没有页码/第X章）
    ("section_header", re.compile(
        r"§\s*\d+(?:\.\d+)*\.?\s*(?:" + _SEC + r")\s*\d{0,4}"), ""),
    # ---- 6. 书名页眉（含粘连的页码）
    ("book_header", re.compile(r"\d{0,4}\s*(?:" + _TITLE + r")"), ""),
]


def clean_text(text: str) -> tuple[str, list[str]]:
    """返回 (清洗后的文本, 触发过的规则名)。"""
    s = text or ""
    fired: list[str] = []
    for name, pat, repl in RULES:
        new = pat.sub(repl, s)
        if new != s:
            fired.append(name)
            s = new
    # `$` 配对不平衡 ⇒ 整条剥掉（交给前端 autoLatex 包裸 LaTeX）
    if s.count("$") % 2 == 1:
        s = s.replace("$", "")
        fired.append("unbalanced_math")
    # 收尾：折叠空白、清掉表格留下的孤立分隔
    s = re.sub(r"[ \t]{2,}", " ", s)
    s = re.sub(r"(?:[ \t]*\|[ \t]*){2,}", " | ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    s = "\n".join(re.sub(r"[ \t]+$", "", line) for line in s.split("\n"))
    return s.strip(), fired


# 兼容旧名（别处可能引用）
clean_stem = clean_text


def clean_bank(bank: dict) -> dict:
    """就地清洗整个候选库的 `stem` 与 `solution`，返回统计。"""
    stats: dict[str, int] = {}
    changed = 0
    for q in bank["questions"]:
        hit_stem = False
        for field in ("stem", "solution"):
            before = q.get(field) or ""
            after, fired = clean_text(before)
            if not fired:
                continue
            if field == "stem":
                hit_stem = True
            q.setdefault("flags", [])
            q["flags"] = sorted(set(q["flags"]) | {f"cleaned:{field}:{f}" for f in fired})
            for f in fired:
                stats[f"{field}.{f}"] = stats.get(f"{field}.{f}", 0) + 1
            q[field] = after
        if hit_stem:
            changed += 1
    bank.setdefault("report", {})["clean_stats"] = stats
    bank["report"]["clean_changed_questions"] = changed
    return bank


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="题面/解析确定性清洗（页眉/水印/表格/数学标记/不平衡 $）")
    ap.add_argument("--candidates", required=True, help="支持 glob（要加引号）")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--samples", type=int, default=1, help="每本书打印几条改前改后对照")
    args = ap.parse_args(argv)

    files = sorted(glob.glob(args.candidates))
    if not files:
        raise SystemExit(f"没有匹配的文件：{args.candidates}")
    for f in files:
        src = Path(f)
        bank = json.loads(src.read_text(encoding="utf-8"))
        bank = clean_bank(bank)
        rep = bank["report"]
        print(f"  {bank['bank']:18s} 题面改了 {rep['clean_changed_questions']:5d}/{len(bank['questions'])} 题")
        for k, v in sorted(rep["clean_stats"].items()):
            print(f"        {k:26s} {v}")
        if args.samples:
            shown = 0
            for q in bank["questions"]:
                if shown >= args.samples:
                    break
                if any(x.startswith("cleaned:stem:") for x in q.get("flags", [])):
                    print(f"      例 {q['qid']}：{q['stem'][:130]!r}")
                    shown += 1
        if not args.dry_run:
            backup = src.with_suffix(".pre-clean.json")
            if not backup.exists():
                shutil.copy2(src, backup)
            src.write_text(json.dumps(bank, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    if not args.dry_run:
        print("✅ 已就地清洗（原文备份 *.pre-clean.json）")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
