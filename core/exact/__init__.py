"""core.exact 的导出面 —— 生成器与判定共用的唯一入口（ARCHITECTURE §11.1）。

调用形式（P1 钦定）：`from core.exact import det, rank, rref, ...`
本文件只做再导出，**不含任何算法**；算法全在 `core/exact/exact.py`（原型原样迁入）。
"""

from .exact import (  # noqa: F401
    F,
    adjugate,
    char_poly,
    cofactor_matrix,
    companion_matrix,
    copy,
    det,
    det_bareiss,
    eigen_space,
    eigen_values,
    equal,
    fmt_frac,
    fmt_mat,
    fmt_row,
    identity,
    integer_matrix_with_eigenvalues,
    inv,
    is_diagonalizable,
    is_square,
    mat,
    mat_is_integer,
    mat_to_int,
    matadd,
    matmul,
    matsub,
    random_unimodular,
    rank,
    rref,
    scalar_mul,
    shape,
    T,
    trace,
    zeros,
)

__all__ = [
    "F", "adjugate", "char_poly", "cofactor_matrix", "companion_matrix", "copy",
    "det", "det_bareiss", "eigen_space", "eigen_values", "equal", "fmt_frac",
    "fmt_mat", "fmt_row", "identity", "integer_matrix_with_eigenvalues", "inv",
    "is_diagonalizable", "is_square", "mat", "mat_is_integer", "mat_to_int",
    "matadd", "matmul", "matsub", "random_unimodular", "rank", "rref",
    "scalar_mul", "shape", "T", "trace", "zeros",
]
