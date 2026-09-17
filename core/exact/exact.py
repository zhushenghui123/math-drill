"""精确矩阵运算 —— 全部基于 fractions.Fraction，无浮点误差。

考研线性代数的题目几乎全是整数/有理数运算，用 Fraction 可以保证：
  1. 判分零歧义（答案相等就是相等，不存在 0.30000000000000004 的问题）
  2. 求逆、求秩、特征值全部精确

不依赖任何第三方库。
"""

from fractions import Fraction
from math import gcd


# ---------------------------------------------------------------- 基础构造

def F(x):
    """把 int / str / Fraction 统一转成 Fraction。"""
    if isinstance(x, Fraction):
        return x
    if isinstance(x, float):
        return Fraction(x).limit_denominator(10 ** 9)
    return Fraction(x)


def mat(M):
    """把嵌套 list 转成 Fraction 矩阵。"""
    return [[F(x) for x in row] for row in M]


def identity(n):
    return [[Fraction(1) if i == j else Fraction(0) for j in range(n)] for i in range(n)]


def zeros(r, c):
    return [[Fraction(0)] * c for _ in range(r)]


def shape(M):
    return (len(M), len(M[0]) if M else 0)


def is_square(M):
    r, c = shape(M)
    return r == c and r > 0


def copy(M):
    return [row[:] for row in M]


def equal(A, B):
    if shape(A) != shape(B):
        return False
    return all(A[i][j] == B[i][j] for i in range(len(A)) for j in range(len(A[0])))


# ---------------------------------------------------------------- 基本运算

def T(M):
    """转置"""
    r, c = shape(M)
    return [[M[i][j] for i in range(r)] for j in range(c)]


def matmul(A, B):
    ra, ca = shape(A)
    rb, cb = shape(B)
    if ca != rb:
        raise ValueError(f"维度不匹配: {ra}x{ca} 乘 {rb}x{cb}")
    out = zeros(ra, cb)
    for i in range(ra):
        Ai = A[i]
        for k in range(ca):
            a = Ai[k]
            if a == 0:
                continue
            Bk = B[k]
            Oi = out[i]
            for j in range(cb):
                Oi[j] += a * Bk[j]
    return out


def matadd(A, B):
    return [[A[i][j] + B[i][j] for j in range(len(A[0]))] for i in range(len(A))]


def matsub(A, B):
    return [[A[i][j] - B[i][j] for j in range(len(A[0]))] for i in range(len(A))]


def scalar_mul(k, A):
    k = F(k)
    return [[k * x for x in row] for row in A]


# ---------------------------------------------------------------- 行列式

def det(M):
    """行列式（分数高斯消元，带部分主元）。"""
    if not is_square(M):
        raise ValueError("行列式要求方阵")
    n = len(M)
    if n == 0:
        return Fraction(1)
    A = mat(M)
    sign = 1
    prod = Fraction(1)
    for i in range(n):
        p = None
        for r in range(i, n):
            if A[r][i] != 0:
                p = r
                break
        if p is None:
            return Fraction(0)
        if p != i:
            A[i], A[p] = A[p], A[i]
            sign = -sign
        piv = A[i][i]
        prod *= piv
        for r in range(i + 1, n):
            f = A[r][i] / piv
            if f != 0:
                Ar, Ai = A[r], A[i]
                for c in range(i, n):
                    Ar[c] -= f * Ai[c]
    return sign * prod


def det_bareiss(M):
    """Bareiss 算法（整数保持），用作 det() 的独立交叉验证。"""
    n = len(M)
    if n == 0:
        return Fraction(1)
    A = mat(M)
    sign = 1
    prev = Fraction(1)
    for k in range(n - 1):
        if A[k][k] == 0:
            sw = None
            for i in range(k + 1, n):
                if A[i][k] != 0:
                    sw = i
                    break
            if sw is None:
                return Fraction(0)
            A[k], A[sw] = A[sw], A[k]
            sign = -sign
        for i in range(k + 1, n):
            for j in range(k + 1, n):
                A[i][j] = (A[i][j] * A[k][k] - A[i][k] * A[k][j]) / prev
        prev = A[k][k]
    return sign * A[n - 1][n - 1]


# ---------------------------------------------------------------- 秩 / 行最简形

def rref(M):
    """返回 (行最简形, 主元列下标列表)。"""
    A = mat(M)
    if not A:
        return A, []
    rows, cols = shape(A)
    pivots = []
    r = 0
    for c in range(cols):
        if r >= rows:
            break
        p = None
        for i in range(r, rows):
            if A[i][c] != 0:
                p = i
                break
        if p is None:
            continue
        A[r], A[p] = A[p], A[r]
        piv = A[r][c]
        A[r] = [x / piv for x in A[r]]
        for i in range(rows):
            if i != r and A[i][c] != 0:
                f = A[i][c]
                Ai, Ar = A[i], A[r]
                for j in range(cols):
                    Ai[j] -= f * Ar[j]
        pivots.append(c)
        r += 1
    # 把全零行挪到最下面，输出更干净
    A.sort(key=lambda row: all(x == 0 for x in row))
    return A, pivots


def rank(M):
    _, p = rref(M)
    return len(p)


# ---------------------------------------------------------------- 逆 / 伴随

def inv(M):
    """求逆矩阵。不可逆返回 None。"""
    if not is_square(M):
        raise ValueError("求逆要求方阵")
    n = len(M)
    A = mat(M)
    aug = [A[i][:] + identity(n)[i] for i in range(n)]
    r = 0
    for c in range(n):
        p = None
        for i in range(r, n):
            if aug[i][c] != 0:
                p = i
                break
        if p is None:
            return None
        aug[r], aug[p] = aug[p], aug[r]
        piv = aug[r][c]
        aug[r] = [x / piv for x in aug[r]]
        for i in range(n):
            if i != r and aug[i][c] != 0:
                f = aug[i][c]
                aug[i] = [a - f * b for a, b in zip(aug[i], aug[r])]
        r += 1
    return [row[n:] for row in aug]


def cofactor_matrix(M):
    """代数余子式矩阵（每个元素的余子式行列式），带符号。"""
    n = len(M)
    C = zeros(n, n)
    for i in range(n):
        for j in range(n):
            sub = [[M[r][c] for c in range(n) if c != j] for r in range(n) if r != i]
            sign = 1 if (i + j) % 2 == 0 else -1
            C[i][j] = sign * det(sub) if sub and sub[0] else Fraction(1 if n == 1 else 0)
    return C


def adjugate(M):
    """伴随矩阵 A* = 代数余子式矩阵的转置。"""
    return T(cofactor_matrix(M))


# ---------------------------------------------------------------- 特征值

def char_poly(M):
    """特征多项式系数（Faddeev–LeVerrier）。

    返回 [1, c1, c2, ..., cn]，对应
        p(λ) = λ^n + c1 λ^(n-1) + c2 λ^(n-2) + ... + cn
    也满足 det(λI - A) = p(λ)。
    """
    if not is_square(M):
        raise ValueError("特征多项式要求方阵")
    n = len(M)
    A = mat(M)
    coeffs = [Fraction(1)]
    Mk = identity(n)
    for k in range(1, n + 1):
        Mk = matmul(A, Mk)
        c = Fraction(sum(Mk[i][i] for i in range(n)), k)
        coeffs.append(-c)
        for i in range(n):
            Mk[i][i] -= c
    return coeffs


def trace(M):
    return sum(M[i][i] for i in range(len(M)))


def _divisor_candidates(const):
    """有理根定理：整系数多项式的有理根 p/q 中 q | a_n, p | a_0。"""
    if const == 0:
        return [Fraction(0)]
    a0 = const.numerator
    an = Fraction(1)  # 首项系数为 1（char_poly 归一化过）
    cands = set()
    for p in _divisors(abs(a0)):
        for q in _divisors(an):
            cands.add(Fraction(p, q))
            cands.add(Fraction(-p, q))
    return sorted(cands)


def _divisors(x):
    x = abs(int(x))
    if x == 0:
        return [1]
    out = set()
    i = 1
    while i * i <= x:
        if x % i == 0:
            out.add(i)
            out.add(x // i)
        i += 1
    return sorted(out)


def _poly_eval_int(coeffs, x):
    """Horner 求值，coeffs 为 Fraction 列表。"""
    r = Fraction(0)
    for c in coeffs:
        r = r * x + c
    return r


def _poly_div(coeffs, root):
    """多项式除以 (x - root)，返回商系数。"""
    out = []
    carry = Fraction(0)
    for c in coeffs:
        carry = c + carry * root
        out.append(carry)
    return out[:-1]


def eigen_values(M):
    """特征值（有理数根全部求出，含重数）。

    只返回有理解 —— 这对考研题完全够用，因为考研题的特征值基本都是整数。
    """
    coeffs = char_poly(M)
    roots = []
    work = coeffs[:]
    while len(work) > 1:
        found = None
        for cand in _divisor_candidates(work[-1]):
            if _poly_eval_int(work, cand) == 0:
                found = cand
                break
        if found is None:
            break
        roots.append(found)
        work = _poly_div(work, found)
    return roots


def eigen_space(M, lam):
    """特征值 lam 对应的特征空间基（返回基向量列表，每个是 Fraction 列表）。"""
    n = len(M)
    lam = F(lam)
    A = matsub(mat(M), scalar_mul(lam, identity(n)))
    R, pivots = rref(A)
    free = [c for c in range(n) if c not in pivots]
    basis = []
    for f in free:
        v = [Fraction(0)] * n
        v[f] = Fraction(1)
        for i, pc in enumerate(pivots):
            v[pc] = -R[i][f]
        basis.append(v)
    return basis


def is_diagonalizable(M):
    """实对称阵必可对角化；一般阵要求每个特征值的几何重数 = 代数重数。"""
    evs = eigen_values(M)
    if len(evs) != len(M):
        return False  # 有非有理特征值，按考研题的语境视为不可对角化
    for lam in set(evs):
        alg = evs.count(lam)
        geo = len(eigen_space(M, lam))
        if geo != alg:
            return False
    return True


# ---------------------------------------------------------------- 整数矩阵工具

def mat_is_integer(M):
    return all(F(x).denominator == 1 for row in M for x in row)


def mat_to_int(M):
    return [[int(F(x)) for x in row] for row in M]


def companion_matrix(roots):
    """由已知根构造伴侣矩阵（特征值 = roots）。

    p(λ) = λ^n + c1λ^(n-1) + ... + cn 的伴侣矩阵为
        [ -c1 -c2 ... -cn ]
        [  1   0  ...  0  ]
        [  0   1  ...  0  ]
    """
    n = len(roots)
    coeffs = [Fraction(1)]
    for r in roots:
        new = [Fraction(0)] * (len(coeffs) + 1)
        for i, c in enumerate(coeffs):
            new[i] += c
            new[i + 1] -= c * F(r)
        coeffs = new
    c = coeffs[1:]
    C = zeros(n, n)
    for j in range(n):
        C[0][j] = -c[j]
    for i in range(1, n):
        C[i][i - 1] = Fraction(1)
    return C


def random_unimodular(n, rng, steps=6, kmax=2):
    """随机生成整数幺模矩阵（det = ±1），用于做相似变换保持整数元素。"""
    P = identity(n)
    for _ in range(steps):
        i, j = rng.sample(range(n), 2)
        k = rng.choice([x for x in range(-kmax, kmax + 1) if x != 0])
        # 第 i 行加上 k 倍的第 j 行
        for c in range(n):
            P[i][c] += k * P[j][c]
        if rng.random() < 0.3:
            P[i], P[j] = P[j], P[i]
    return P


def integer_matrix_with_eigenvalues(roots, rng):
    """生成一个看起来"自然"的整数矩阵，其特征值恰为 roots。

    做法：先造伴侣矩阵，再用幺模矩阵做相似变换 A = P C P^-1。
    因为 P 和 P^-1 都是整数矩阵，结果矩阵元素仍是整数。
    """
    n = len(roots)
    C = companion_matrix(roots)
    for _ in range(20):
        P = random_unimodular(n, rng)
        Pi = inv(P)
        if Pi is None:
            continue
        A = matmul(matmul(P, C), Pi)
        if mat_is_integer(A):
            # 避免出现明显是伴侣矩阵/三角阵的平凡形态
            if rank(A) == n or any(r == 0 for r in roots):
                return mat_to_int(A)
    return mat_to_int(C)


# ---------------------------------------------------------------- 格式化

def fmt_frac(x):
    """Fraction -> 显示字符串（整数不带分母）。"""
    x = F(x)
    if x.denominator == 1:
        return str(x.numerator)
    return f"{x.numerator}/{x.denominator}"


def fmt_row(vec):
    return " ".join(fmt_frac(x) for x in vec)


def fmt_mat(M):
    return "; ".join(fmt_row(r) for r in M)
