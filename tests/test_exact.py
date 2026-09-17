"""exact.py 的验证测试。

策略：不靠"我看着对"，而是靠**独立的数学恒等式**互相校验：
  1. det()  与 det_bareiss() 是两套独立算法，必须一致
  2. A · A⁻¹ = I
  3. A · A* = |A| · I      （伴随矩阵的定义式）
  4. p(0) = (-1)ⁿ|A|       （特征多项式在 0 处的取值）
  5. p(λᵢ) = 0             （特征值必须是根）
  6. rank(A) = rank(Aᵀ)，且 rref 的主元数 = rank
"""

import random
import sys
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.exact import exact as ex  # noqa: E402  （T0.5：原型 drill/exact.py → core/exact/exact.py）

FAILED = []
PASSED = 0


def check(name, cond, detail=""):
    global PASSED
    if cond:
        PASSED += 1
    else:
        FAILED.append(f"{name}  {detail}")
        print(f"  ✗ {name}  {detail}")


def rand_int_mat(n, m, rng, lo=-4, hi=4):
    return [[rng.randint(lo, hi) for _ in range(m)] for _ in range(n)]


# ---------------------------------------------------------------- 1. 已知值

def test_known():
    print("[1] 已知值")
    check("2x2 det", ex.det([[1, 2], [3, 4]]) == -2)
    check("3x3 det", ex.det([[1, 2, 3], [4, 5, 6], [7, 8, 10]]) == -3)
    check("单位阵 det", ex.det(ex.identity(4)) == 1)
    check("奇异阵 det=0", ex.det([[1, 2], [2, 4]]) == 0)
    check("三角阵 det=对角积", ex.det([[2, 9, 9], [0, 3, 9], [0, 0, 5]]) == 30)
    check("1x1 det", ex.det([[7]]) == 7)
    check("交换行变号",
          ex.det([[3, 4], [1, 2]]) == -ex.det([[1, 2], [3, 4]]))

    # 范德蒙德：(b-a)(c-a)(c-b)
    M = [[1, 1, 1], [2, 3, 5], [4, 9, 25]]
    check("范德蒙德", ex.det(M) == (3 - 2) * (5 - 2) * (5 - 3), f"got {ex.det(M)}")

    check("秩 满秩", ex.rank([[1, 2], [3, 4]]) == 2)
    check("秩 行相关", ex.rank([[1, 2], [2, 4]]) == 1)
    check("秩 零阵", ex.rank([[0, 0], [0, 0]]) == 0)
    check("秩 非方阵", ex.rank([[1, 2, 3], [2, 4, 6]]) == 1)
    check("秩 单位阵", ex.rank(ex.identity(5)) == 5)


# ---------------------------------------------------------------- 2. 交叉验证

def test_cross_validation():
    print("[2] det 双算法交叉验证（随机 400 例）")
    rng = random.Random(20260914)
    bad = 0
    for _ in range(400):
        n = rng.randint(1, 5)
        M = rand_int_mat(n, n, rng)
        a, b = ex.det(M), ex.det_bareiss(M)
        if a != b:
            bad += 1
            if bad <= 3:
                print(f"    不一致: {M}  gauss={a} bareiss={b}")
    check("det 两算法一致", bad == 0, f"{bad}/400 不一致")


# ---------------------------------------------------------------- 3. 恒等式

def test_identities():
    print("[3] 矩阵恒等式（随机 250 例）")
    rng = random.Random(42)

    inv_ok = adj_ok = 0
    inv_n = adj_n = 0
    for _ in range(250):
        n = rng.randint(2, 4)
        M = ex.mat(rand_int_mat(n, n, rng))
        d = ex.det(M)
        I = ex.identity(n)

        # A·A⁻¹ = I
        if d != 0:
            inv_n += 1
            Ai = ex.inv(M)
            if Ai is not None and ex.equal(ex.matmul(M, Ai), I):
                inv_ok += 1

        # A·A* = |A|·I    （对不可逆阵也成立）
        adj_n += 1
        A_star = ex.adjugate(M)
        if ex.equal(ex.matmul(M, A_star), ex.scalar_mul(d, I)):
            adj_ok += 1

    check("A·A⁻¹=I", inv_ok == inv_n, f"{inv_ok}/{inv_n}")
    check("A·A*=|A|I", adj_ok == adj_n, f"{adj_ok}/{adj_n}")

    # 不可逆时 inv 必须返回 None
    check("奇异阵 inv=None", ex.inv([[1, 2], [2, 4]]) is None)


# ---------------------------------------------------------------- 4. 特征多项式

def test_char_poly():
    print("[4] 特征多项式（随机 200 例）")
    rng = random.Random(7)

    p0_ok = p0_n = 0
    root_ok = root_n = 0
    deg_ok = 0
    for _ in range(200):
        n = rng.randint(2, 4)
        M = ex.mat(rand_int_mat(n, n, rng))
        coeffs = ex.char_poly(M)

        # 次数必须是 n+1
        if len(coeffs) == n + 1 and coeffs[0] == 1:
            deg_ok += 1

        # p(0) = (-1)^n |A|
        expected = ex.det(M) * ((-1) ** n)
        p0_n += 1
        if coeffs[-1] == expected:
            p0_ok += 1

        # 每个特征值都是根
        for lam in ex.eigen_values(M):
            root_n += 1
            if ex._poly_eval_int(coeffs, lam) == 0:
                root_ok += 1

    check("次数与首项", deg_ok == 200, f"{deg_ok}/200")
    check("p(0)=(-1)ⁿ|A|", p0_ok == p0_n, f"{p0_ok}/{p0_n}")
    check("特征值是根", root_ok == root_n, f"{root_ok}/{root_n}")


# ---------------------------------------------------------------- 5. 特征值 / 特征向量

def test_eigen():
    print("[5] 特征值与特征向量")

    # 已知特征值
    A = [[2, 1, 0], [0, 3, 1], [0, 0, 4]]  # 上三角 -> 特征值 2,3,4
    evs = sorted(ex.eigen_values(A))
    check("上三角特征值", evs == [Fraction(2), Fraction(3), Fraction(4)], f"got {evs}")

    # 对称阵 [[2,1],[1,2]] -> 特征值 1, 3
    evs2 = sorted(ex.eigen_values([[2, 1], [1, 2]]))
    check("对称阵特征值", evs2 == [Fraction(1), Fraction(3)], f"got {evs2}")

    # 特征向量必须满足 Av = λv
    rng = random.Random(99)
    ok = n = 0
    for _ in range(120):
        k = rng.randint(2, 3)
        roots = [rng.randint(-3, 3) for _ in range(k)]
        M = ex.mat(ex.integer_matrix_with_eigenvalues(roots, rng))
        for lam in ex.eigen_values(M):
            for v in ex.eigen_space(M, lam):
                n += 1
                Mv = [sum(M[i][j] * v[j] for j in range(k)) for i in range(k)]
                lv = [ex.F(lam) * x for x in v]
                if Mv == lv:
                    ok += 1
    check("Av=λv 恒等式", ok == n, f"{ok}/{n}")

    check("可对角化(对称)", ex.is_diagonalizable([[2, 1], [1, 2]]) is True)
    check("不可对角化(若当)", ex.is_diagonalizable([[1, 1], [0, 1]]) is False)


# ---------------------------------------------------------------- 6. 生成器契约

def test_generator_contract():
    print("[6] 整数特征值矩阵生成器")
    rng = random.Random(1234)
    ok = n = 0
    integral = 0
    for _ in range(150):
        k = rng.randint(2, 3)
        roots = [rng.randint(-4, 4) for _ in range(k)]
        M = ex.integer_matrix_with_eigenvalues(roots, rng)
        n += 1
        if ex.mat_is_integer(M):
            integral += 1
        got = sorted(ex.eigen_values(ex.mat(M)))
        if got == sorted(ex.F(r) for r in roots):
            ok += 1
    check("特征值正确", ok == n, f"{ok}/{n}")
    check("元素为整数", integral == n, f"{integral}/{n}")

    # 伴侣矩阵本身
    C = ex.companion_matrix([1, 2, 3])
    check("伴侣矩阵特征值", sorted(ex.eigen_values(C)) == [Fraction(1), Fraction(2), Fraction(3)])


# ---------------------------------------------------------------- 7. 维数一致性

def test_shapes():
    print("[7] 维度与转置一致性")
    rng = random.Random(555)
    ok = 0
    for _ in range(200):
        r, c = rng.randint(1, 4), rng.randint(1, 4)
        M = rand_int_mat(r, c, rng)
        if ex.rank(M) == ex.rank(ex.T(M)) == len(ex.rref(M)[1]):
            ok += 1
    check("rank(A)=rank(Aᵀ)=主元数", ok == 200, f"{ok}/200")

    # 乘法维度错误必须抛异常
    try:
        ex.matmul([[1, 2]], [[1, 2]])
        check("维度不匹配报错", False)
    except ValueError:
        check("维度不匹配报错", True)


def main():
    for fn in (test_known, test_cross_validation, test_identities,
               test_char_poly, test_eigen, test_generator_contract, test_shapes):
        fn()
    print()
    print("=" * 52)
    if FAILED:
        print(f"❌ 失败 {len(FAILED)} 项 / 通过 {PASSED} 项")
        for f in FAILED:
            print("   -", f)
        return 1
    print(f"✅ 全部通过：{PASSED} 项断言")
    return 0


if __name__ == "__main__":
    sys.exit(main())
