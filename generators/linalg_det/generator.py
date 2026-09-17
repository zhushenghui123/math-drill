"""generators/linalg_det/generator.py —— 线代第八章「行列式」题源（ARCHITECTURE §10.D）。

接口（T6 契约）：
    generate(seed:int, per_family:int) -> list[dict]      # 稳定题目对象，字段见 ARCHITECTURE §3.1

两条硬性质：
  ① **可复现门**：同 seed 同输出（随机数只用 `random.Random(整数种子)`——不用字符串种子，
     因为 str 的 hash 受 PYTHONHASHSEED 影响，跨进程会漂）。
  ② **真值可靠**：答案是**算出来的**，而且用第二套算法复算（det vs det_bareiss），
     由 tests 与 gen_bundles 双重把关——不是人工敲进去的常量。

依赖方向（§11.4）：`generators → core` 合法，这里只用 `core.exact` 的精确算术。
真题/书稿数据一律不入库（H8）：本文件全部题目都是**现算**的。
"""

from __future__ import annotations

import hashlib
import json
import random
from fractions import Fraction

from core.exact import det, det_bareiss

__all__ = ["generate", "FAMILIES", "KIDS", "BUNDLE_VERSION", "question_id"]

BUNDLE_VERSION = 1

#: 第八章（行列式）的知识点 id —— 与 fork 的 68 考点树对齐（web/js/data-knowledge.js）
KIDS = {
    "prop": "l1n1",      # 行列式的性质与计算
    "expand": "l1n2",    # 行列式按行（列）展开
    "cramer": "l1n3",    # 克拉默法则
}


def _frac_str(x) -> str:
    """答案的规范存储形式：整数写 'n'，其余写 'p/q'（与判定器的 canonical 约定一致）。"""
    f = Fraction(x)
    return str(f.numerator) if f.denominator == 1 else f"{f.numerator}/{f.denominator}"


def _mat_tex(M: list[list[int]]) -> str:
    rows = " \\\\ ".join(" & ".join(str(v) for v in row) for row in M)
    return "\\begin{vmatrix} " + rows + " \\end{vmatrix}"


def _term(coef: int, var: str) -> str:
    """线性项的排版：1x → x，-1x → -x，0x → 0（教材写法）。"""
    if coef == 1:
        return var
    if coef == -1:
        return "-" + var
    return f"{coef}{var}"


def question_id(gen_params: dict) -> str:
    """稳定 id = hash(gen_params)：同参数再生同题（ARCHITECTURE §3.1）。"""
    payload = json.dumps(gen_params, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return "lin.det." + hashlib.sha1(payload).hexdigest()[:12]


def _q(*, family: str, params: dict, kid: str, difficulty: int, stem: str,
       answer, analysis: str, qtype: str = "blank", options=None) -> dict:
    gen_params = {"family": family, "kid": kid, "params": params}
    return {
        "id": question_id(gen_params),
        "bundle_version": BUNDLE_VERSION,
        "kid": kid,
        "type": qtype,
        "answer_type": "rational",
        "stem": stem,
        "options": json.dumps(options, ensure_ascii=False) if options else None,
        # blank 题存规范数值串；choice 题存选项键（键的语义由 options 决定）
        "answer": answer if qtype == "choice" else _frac_str(answer),
        "analysis": analysis,
        "difficulty": difficulty,
        "gen_params": json.dumps(gen_params, ensure_ascii=False, sort_keys=True),
        "source": "generated",
    }


# ---------------------------------------------------------------- 八个题族

def _gen_det2(rng: random.Random) -> dict:
    a, b, c, d = (rng.randint(-9, 9) for _ in range(4))
    M = [[a, b], [c, d]]
    val = det(M)
    return _q(family="det2", params={"M": M}, kid=KIDS["prop"], difficulty=1,
              stem=f"计算二阶行列式 {_mat_tex(M)} 的值。",
              answer=val,
              analysis=f"二阶行列式 = ad - bc = {a}×{d} - {b}×{c} = {_frac_str(val)}。")


def _gen_det3_tri(rng: random.Random) -> dict:
    n = 3
    diag = [rng.choice([-3, -2, -1, 1, 2, 3, 4]) for _ in range(n)]
    upper = rng.random() < 0.5
    M = [[0] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            if i == j:
                M[i][j] = diag[i]
            elif (j > i) if upper else (j < i):
                M[i][j] = rng.randint(-5, 5)
    val = det(M)
    kind = "上三角" if upper else "下三角"
    prod = "×".join(str(x) for x in diag)
    return _q(family="det3_tri", params={"M": M}, kid=KIDS["prop"], difficulty=2,
              stem=f"计算{kind}行列式 {_mat_tex(M)} 的值。",
              answer=val,
              analysis=f"{kind}行列式等于主对角线元素之积：{prod} = {_frac_str(val)}。")


def _gen_det3(rng: random.Random) -> dict:
    M = [[rng.randint(-6, 6) for _ in range(3)] for _ in range(3)]
    val = det(M)
    if val == 0:
        M[0][0] += 1
        val = det(M)
    return _q(family="det3", params={"M": M}, kid=KIDS["prop"], difficulty=3,
              stem=f"计算三阶行列式 {_mat_tex(M)} 的值。",
              answer=val,
              analysis="按行展开或化上三角后计算；本题已用两套独立算法（展开 / Bareiss）互证。")


def _gen_det4(rng: random.Random) -> dict:
    M = [[rng.randint(-4, 4) for _ in range(4)] for _ in range(4)]
    val = det(M)
    while val == 0:
        M[rng.randrange(4)][rng.randrange(4)] += rng.choice([-2, -1, 1, 2])
        val = det(M)
    return _q(family="det4", params={"M": M}, kid=KIDS["prop"], difficulty=4,
              stem=f"计算四阶行列式 {_mat_tex(M)} 的值。",
              answer=val,
              analysis="四阶建议先做行变换制造 0 再展开；本题答案已双算法互证。")


def _gen_vandermonde(rng: random.Random) -> dict:
    xs = rng.sample(range(-4, 6), 3)
    M = [[x ** j for j in range(3)] for x in xs]
    val = det(M)
    pairs = f"({xs[1]}-{xs[0]})({xs[2]}-{xs[0]})({xs[2]}-{xs[1]})"
    return _q(family="vandermonde", params={"xs": xs, "M": M}, kid=KIDS["prop"], difficulty=3,
              stem=f"计算范德蒙德行列式 {_mat_tex(M)} 的值。",
              answer=val,
              analysis=f"三阶范德蒙德 = ∏(x_j - x_i) = {pairs} = {_frac_str(val)}。")


def _gen_cofactor_sum(rng: random.Random) -> dict:
    """按第一行展开的经典用法：A₁₁+A₁₂+A₁₃ = 把首行换成 1 后的行列式。"""
    M = [[rng.randint(-5, 5) for _ in range(3)] for _ in range(3)]
    M[0] = [rng.randint(-5, 5) for _ in range(3)]
    replaced = [[1, 1, 1], M[1], M[2]]
    val = det(replaced)
    return _q(family="cofactor_sum",
              params={"M": M, "verify_matrix": replaced}, kid=KIDS["expand"], difficulty=3,
              stem=f"设 A = {_mat_tex(M).replace('vmatrix', 'bmatrix')}，"
                   f"求 A₁₁ + A₁₂ + A₁₃（A_{'{'}1j{'}'} 为第一行的代数余子式）。",
              answer=val,
              analysis=f"把首行换成 (1,1,1) 后取行列式即得："
                       f"{_mat_tex(replaced)} = {_frac_str(val)}（异行代数余子式之和为 0 的配套结论）。")


def _gen_cramer(rng: random.Random) -> dict:
    while True:
        a, b, c, d = (rng.randint(-6, 6) for _ in range(4))
        D = det([[a, b], [c, d]])
        if D != 0:
            break
    b1, b2 = rng.randint(-9, 9), rng.randint(-9, 9)
    Dx1 = det([[b1, b], [b2, d]])
    val = Fraction(Dx1, D)
    return _q(family="cramer", params={"a": a, "b": b, "c": c, "d": d, "b1": b1, "b2": b2},
              kid=KIDS["cramer"], difficulty=3,
              stem="用克拉默法则解方程组，求 x₁：\n"
                   f"\\begin{{cases}} {_term(a, 'x_1')} + {_term(b, 'x_2')} = {b1} \\\\ "
                   f"{_term(c, 'x_1')} + {_term(d, 'x_2')} = {b2} \\end{{cases}}",
              answer=val,
              analysis=f"系数行列式 D = {_mat_tex([[a, b], [c, d]])} = {D} ≠ 0；"
                       f"D₁ = {_mat_tex([[b1, b], [b2, d]])} = {Dx1}；"
                       f"故 x₁ = D₁/D = {_frac_str(val)}。")


def _gen_choice_det3(rng: random.Random) -> dict:
    M = [[rng.randint(-5, 5) for _ in range(3)] for _ in range(3)]
    val = det(M)
    if val == 0:
        M[0][0] += 1
        val = det(M)
    distractors = {val + rng.choice([-6, -3, -2, -1, 1, 2, 3, 6]),
                   -val,
                   val + rng.choice([-8, -5, 4, 5, 8])}
    distractors.discard(val)
    opts = [val] + list(distractors)[:3]
    while len(opts) < 4:
        cand = val + rng.randint(-9, 9)
        if cand != val and cand not in opts:
            opts.append(cand)
    rng.shuffle(opts)
    keys = "ABCD"
    options = [{"k": keys[i], "t": _frac_str(v)} for i, v in enumerate(opts)]
    answer_key = keys[opts.index(val)]
    return _q(family="choice_det3", params={"M": M, "opts": [_frac_str(v) for v in opts]},
              kid=KIDS["prop"],
              difficulty=2, qtype="choice",
              stem=f"三阶行列式 {_mat_tex(M)} 的值为",
              answer=answer_key, options=options,
              analysis=f"计算得 {_frac_str(val)}（选项 {answer_key}）；干扰项含相反数与相邻值。")


FAMILIES = (
    ("det2", _gen_det2),
    ("det3_tri", _gen_det3_tri),
    ("det3", _gen_det3),
    ("det4", _gen_det4),
    ("vandermonde", _gen_vandermonde),
    ("cofactor_sum", _gen_cofactor_sum),
    ("cramer", _gen_cramer),
    ("choice_det3", _gen_choice_det3),
)


def generate(*, seed: int = 1, per_family: int = 6) -> list[dict]:
    """生成题目：同 seed 同输出（可复现门）。每题都做**双算法互证**，不一致即报错。"""
    out: list[dict] = []
    for idx, (name, fn) in enumerate(FAMILIES):
        rng = random.Random(seed * 1009 + idx)      # 整数种子：跨进程稳定
        for _ in range(per_family):
            q = fn(rng)
            _verify(q)
            out.append(q)
    seen = set()
    for q in out:
        if q["id"] in seen:
            raise AssertionError(f"题目 id 冲突：{q['id']}")
        seen.add(q["id"])
    return out


def _verify(q: dict) -> None:
    """行内互证：答案必须能被**第二套算法**独立复算出来（不一致就报错，不许带病出厂）。"""
    gp = json.loads(q["gen_params"])
    fam, params = gp["family"], gp["params"]

    if fam == "cramer":            # 用 Bareiss 重算 D 与 D₁，再核对 x₁
        a, b, c, d = params["a"], params["b"], params["c"], params["d"]
        b1, b2 = params["b1"], params["b2"]
        D = det_bareiss([[a, b], [c, d]])
        D1 = det_bareiss([[b1, b], [b2, d]])
        if D == 0 or Fraction(D1, D) != Fraction(q["answer"]):
            raise AssertionError(f"克拉默复算不符：{q['id']}")
        return

    M = params.get("verify_matrix") or params.get("M")
    if not M:
        return
    x, y = det(M), det_bareiss(M)
    if x != y:
        raise AssertionError(f"两套算法不一致：{q['id']} det={x} bareiss={y}")
    if q["type"] == "blank":
        if Fraction(q["answer"]) != x:
            raise AssertionError(f"答案与复算不符：{q['id']} {q['answer']} vs {x}")
    elif q["type"] == "choice":
        opts = {o["k"]: o["t"] for o in json.loads(q["options"])}
        if q["answer"] not in opts or Fraction(opts[q["answer"]]) != x:
            raise AssertionError(f"选择题正确项与复算不符：{q['id']}")
