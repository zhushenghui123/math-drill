"""contracts/answer_types.py —— JUDGE_CONTRACT §1/§2 的机器可读化（纯声明，无逻辑）。

契约纪律（JUDGE_CONTRACT §6）：本文件的改动必须伴随判定测试的同步改动。
"""

from enum import Enum


class AnswerType(str, Enum):
    """§2 答案类型表。`integer` 不单列——并入 `rational`（§2.1）。"""

    RATIONAL = "rational"
    VECTOR = "vector"
    MATRIX = "matrix"
    INTERVAL = "interval"
    SET = "set"
    SYMBOLIC = "symbolic"
    SELF_REPORT = "self_report"


class Verdict(str, Enum):
    """§1.2 响应里的判决取值。"""

    SERVER_TRUE = "server_true"
    SERVER_FALSE = "server_false"
    UNDECIDABLE = "undecidable"
    SELF_REPORTED = "self_reported"


class ErrorCode(str, Enum):
    """§1.2 的 4xx 错误码。"""

    MALFORMED_REQUEST = "malformed_request"
    UNKNOWN_QID = "unknown_qid"
    TYPE_MISMATCH = "type_mismatch"


#: MVP 可自动判定的类型（§2 表里标 ✅ 的三个）
AUTO_JUDGED = (AnswerType.RATIONAL, AnswerType.VECTOR, AnswerType.MATRIX)

#: 类型在枚举里但 MVP 不实现自动判定（§2 标 🔜 P4）；fail-closed → undecidable
DEFERRED = (AnswerType.INTERVAL, AnswerType.SET)
