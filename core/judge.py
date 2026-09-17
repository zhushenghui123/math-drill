"""core/judge.py —— fail-closed 判定器（ADR-003 / docs/JUDGE_CONTRACT.md v1）。

不变量（JUDGE_CONTRACT §0）：
  I1 判定只发生在这里；调用方只上传**原始输入字符串**。
  I2 本模块无 LLM、无网络（纯字符串/分数运算）——由 tests + grep 证据双重守住。
  I3 fail-closed：证不出相等 → `undecidable`，**绝不回退猜测**。
     历史病根是 fork 的**数值前缀解析回退**（把 "1+sqrt(2)" 解析成 1，于是 "1" 被判 true）——
     本模块**不含任何前缀解析、不含浮点容差**（§2.2 明确删除这两条路）。
  I4 必须走**声明类型的文法**，不得跨类型兜底。
  I6 self_report 是一等公民通道（不是降级品）。

比较只有两条路（§2.2）：① 归一化后**字符串精确相等**；② 类型内**规范型精确判等**。
没有第三条路——不做模糊匹配、不做编辑距离、不做容差。

I5（attempts 由 judge 独占写入）落在存储侧：本模块只产出判决，
写库由 T2 的 core/store.py 承接，且只接受本模块的输出。
"""

from __future__ import annotations

import re
from fractions import Fraction

from contracts.answer_types import AUTO_JUDGED, DEFERRED, AnswerType, ErrorCode, Verdict

__all__ = ["JudgeError", "judge", "judge_by_qid", "norm", "parse_typed"]


class JudgeError(Exception):
    """带错误码的判定错误（对应 §1.2 的 4xx）。"""

    def __init__(self, code: str | ErrorCode, message: str = "") -> None:
        self.code = code.value if isinstance(code, ErrorCode) else code
        super().__init__(f"{self.code}: {message}" if message else self.code)


class _ParseError(Exception):
    """类型内解析失败（内部信号 → undecidable，不外抛）。"""


# ---------------------------------------------------------------- 归一化

_FULLWIDTH_BASE = 0xFEE0
_CJK_PUNCT = {
    "，": ",", "。": ".", "；": ";", "：": ":", "（": "(", "）": ")",
    "【": "[", "】": "]", "｛": "{", "｝": "}", "、": ",", "～": "~",
    "−": "-", "－": "-", "＋": "+", "＝": "=", "＊": "*", "／": "/",
}
_SYMBOL_MAP = {"π": "pi", "√": "sqrt", "×": "*", "÷": "/", "²": "^2", "³": "^3"}
_FRAC_RE = re.compile(r"\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}")


def norm(s: str) -> str:
    """归一化（§2.2 的保留清单）：全角→半角、中文标点→英文、LaTeX 展开、去多余空白。

    注意：**不删除**词间空格（向量/矩阵靠空格分隔），只把空白串压成一个空格并去掉
    紧贴分隔符/运算符的空白。归一化必须幂等（性质测试 P2）。

    与 fork（`web/js/engine.js` 的 `Judge.norm`）的**刻意差异**（不是漂移，正是要修的病根）：
      ① 空白：fork 全删（`\\s+`→''）；我们压成一个空格——向量/矩阵靠空格分隔，全删就没法解析
      ② 字母 `x`：fork 映射成 `*`（于是 "3x" 归一化后与 "3" 相同 → 假阳性）；我们**不映射**
      ③ `^` 与 `*`：fork 在比较前把它们删掉（于是 "1^2" 与 "1" 相同 → 假阳性）；我们**不删**
    """
    if not isinstance(s, str):
        raise JudgeError(ErrorCode.MALFORMED_REQUEST, "raw_answer/canonical 必须是字符串")
    t = "".join(
        chr(ord(ch) - _FULLWIDTH_BASE) if 0xFF01 <= ord(ch) <= 0xFF5E else ch
        for ch in s
    )
    t = t.replace("\u3000", " ").replace("\t", " ").replace("\n", " ")
    for a, b in _CJK_PUNCT.items():
        t = t.replace(a, b)
    for a, b in _SYMBOL_MAP.items():
        t = t.replace(a, b)
    for _ in range(3):                       # \frac 可能嵌套一层
        t2 = _FRAC_RE.sub(r"(\1)/(\2)", t)
        if t2 == t:
            break
        t = t2
    t = t.replace("\\", "")                  # 其余 LaTeX 反斜杠（\pi → pi）
    t = t.strip().lower()
    t = re.sub(r"\s+", " ", t)
    t = re.sub(r"\s*([/^(),;\[\]{}])\s*", r"\1", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


# ---------------------------------------------------------------- 类型解析

#: 有理数的"字符白名单"（业务约定：答案形态是教学规范，不是库能力）
_RATIONAL_CHARS = re.compile(r"^[0-9./+\-]+$")
_BRACKETS_RE = re.compile(r"^[\[(](.*)[\])]$")


def _parse_rational(text: str) -> Fraction:
    """有理数解析：**值交给成熟解析器 `fractions.Fraction`**，本函数只做"哪些写法算数"。

    不用自己写数值文法：`Fraction` 已经能正确解析 `3/2` / `-0.5` / `.5` / `1.` 并给出
    精确值（不经过 float）。我们只加一条白名单，挡掉它过于宽松的写法（`1e3`、`1_000`）。
    """
    s = text.strip()
    if not s:
        raise _ParseError("空输入")
    if not _RATIONAL_CHARS.fullmatch(s):
        raise _ParseError(f"不是有理数文法: {s!r}")
    try:
        return Fraction(s)
    except (ValueError, ZeroDivisionError) as exc:
        raise _ParseError(f"Fraction 拒绝 {s!r}: {exc}") from exc


def _strip_brackets(s: str) -> str:
    m = _BRACKETS_RE.match(s.strip())
    return m.group(1).strip() if m else s.strip()


def _split_components(s: str) -> list[str]:
    s = _strip_brackets(s)
    s = s.replace(",", " ")
    return [c for c in s.split(" ") if c]


def _parse_vector(text: str) -> tuple[Fraction, ...]:
    s = _strip_brackets(text.strip())
    if ";" in s:
        raise _ParseError("向量文法不接受行分隔符")
    comps = _split_components(s)
    if not comps:
        raise _ParseError("空向量")
    return tuple(_parse_rational(c) for c in comps)


def _parse_matrix(text: str) -> tuple[tuple[Fraction, ...], ...]:
    s = _strip_brackets(text.strip())
    rows = [r.strip() for r in s.split(";")]
    if not rows or any(not r for r in rows):
        raise _ParseError("矩阵有空行")
    parsed = [tuple(_parse_rational(c) for c in _split_components(r)) for r in rows]
    if not parsed or not parsed[0]:
        raise _ParseError("空矩阵")
    width = len(parsed[0])
    if any(len(r) != width for r in parsed):
        raise _ParseError("矩阵行宽不一致")
    return tuple(parsed)


_PARSERS = {
    AnswerType.RATIONAL: _parse_rational,
    AnswerType.VECTOR: _parse_vector,
    AnswerType.MATRIX: _parse_matrix,
}


def parse_typed(text: str, answer_type: AnswerType):
    """按声明类型解析为规范型；失败抛 _ParseError（调用方转 undecidable）。"""
    parser = _PARSERS.get(answer_type)
    if parser is None:
        raise JudgeError(ErrorCode.TYPE_MISMATCH, f"类型 {answer_type} 无解析器")
    return parser(text)


def _shape(value) -> tuple:
    """形状指纹：向量看分量数，矩阵看行列数。"""
    if isinstance(value, Fraction):
        return ()
    if isinstance(value, tuple) and value and isinstance(value[0], tuple):
        return (len(value), len(value[0]))
    return (len(value),)


def _render(value) -> str:
    """规范型的展示形式（写进 accepted_forms）。"""
    if isinstance(value, Fraction):
        return f"{value.numerator}/{value.denominator}"
    if isinstance(value, tuple) and value and isinstance(value[0], tuple):
        return "; ".join(" ".join(str(c) for c in row) for row in value)
    return " ".join(str(c) for c in value)


def _accepted_forms(value) -> list[str]:
    forms = [_render(value)]
    if isinstance(value, Fraction) and value.denominator == 1:
        forms.append(f"{value.numerator}/1")
    return forms


# ---------------------------------------------------------------- 判定主流程

_SELF_TRUE = {"对", "正确", "true", "1", "yes", "y"}
_SELF_FALSE = {"错", "错误", "false", "0", "no", "n"}


def _coerce_type(answer_type) -> AnswerType:
    if isinstance(answer_type, AnswerType):
        return answer_type
    try:
        return AnswerType(str(answer_type))
    except ValueError as exc:
        raise JudgeError(ErrorCode.TYPE_MISMATCH, f"未知 answer_type: {answer_type!r}") from exc


def judge(raw_answer: str, *, answer_type, canonical: str) -> dict:
    """判定单题（§3 fail-closed 决策树）。返回 §1.2 的响应结构。"""
    atype = _coerce_type(answer_type)

    if not isinstance(raw_answer, str) or not isinstance(canonical, str):
        raise JudgeError(ErrorCode.MALFORMED_REQUEST, "raw_answer/canonical 必须是字符串")

    base = {"canonical": canonical, "answer_type": atype.value}

    # self_report：一等公民通道（I6）——不比对
    if atype is AnswerType.SELF_REPORT:
        s = norm(raw_answer)
        if s in _SELF_TRUE:
            return {**base, "verdict": Verdict.SELF_REPORTED.value, "correct": True,
                    "detail": {"reason": "self-report", "accepted_forms": []}}
        if s in _SELF_FALSE:
            return {**base, "verdict": Verdict.SELF_REPORTED.value, "correct": False,
                    "detail": {"reason": "self-report", "accepted_forms": []}}
        raise JudgeError(ErrorCode.MALFORMED_REQUEST, f"自评取值无法识别: {raw_answer!r}")

    # symbolic：MVP 强制走自评（§2 表 / §7）
    if atype is AnswerType.SYMBOLIC:
        return {**base, "verdict": Verdict.SELF_REPORTED.value, "correct": None,
                "detail": {"reason": "symbolic-deferred",
                           "accepted_forms": [],
                           "note": "本题考查符号表达式，MVP 不支持自动判分，请对照标准答案自评"}}

    # interval / set：枚举里有、MVP 未实现 → fail-closed
    if atype in DEFERRED:
        return {**base, "verdict": Verdict.UNDECIDABLE.value, "correct": None,
                "detail": {"reason": "type_not_supported", "accepted_forms": []}}

    if atype not in AUTO_JUDGED:      # 兜底：不该发生
        raise JudgeError(ErrorCode.TYPE_MISMATCH, f"类型 {atype} 不支持自动判定")

    n_raw, n_can = norm(raw_answer), norm(canonical)

    # ① 字符串精确相等（§2.2 的第一条路；π/pi 这类符号靠它）
    if n_raw == n_can and n_raw:
        return {**base, "verdict": Verdict.SERVER_TRUE.value, "correct": True,
                "detail": {"reason": "string-exact", "accepted_forms": [n_can]}}

    # ② 类型内规范型精确判等
    try:
        parsed_can = parse_typed(n_can, atype)
    except _ParseError:
        # 标准答案不在声明类型内 ⇒ 它不可能是用户那个合法值的相等物
        try:
            parse_typed(n_raw, atype)
        except _ParseError:
            return {**base, "verdict": Verdict.UNDECIDABLE.value, "correct": None,
                    "detail": {"reason": "parse_failed", "accepted_forms": []}}
        return {**base, "verdict": Verdict.SERVER_FALSE.value, "correct": False,
                "detail": {"reason": "canonical_not_in_type", "accepted_forms": []}}

    try:
        parsed_raw = parse_typed(n_raw, atype)
    except _ParseError:
        return {**base, "verdict": Verdict.UNDECIDABLE.value, "correct": None,
                "detail": {"reason": "parse_failed", "accepted_forms": _accepted_forms(parsed_can)}}

    if _shape(parsed_raw) != _shape(parsed_can):
        return {**base, "verdict": Verdict.UNDECIDABLE.value, "correct": None,
                "detail": {"reason": "type_mismatch", "accepted_forms": _accepted_forms(parsed_can)}}

    if parsed_raw == parsed_can:
        return {**base, "verdict": Verdict.SERVER_TRUE.value, "correct": True,
                "detail": {"reason": "parsed-equal", "accepted_forms": _accepted_forms(parsed_can)}}
    return {**base, "verdict": Verdict.SERVER_FALSE.value, "correct": False,
            "detail": {"reason": "value-mismatch", "accepted_forms": _accepted_forms(parsed_can)}}


def judge_by_qid(qid: str, raw_answer: str, *, lookup) -> dict:
    """按 qid 判定：`lookup(qid) -> (answer_type, canonical)`，查不到则抛 JudgeError(unknown_qid)。

    这样判定核心保持纯粹（不碰库）；T3 的 bridge 用真实 questions 表实现 lookup。
    """
    try:
        answer_type, canonical = lookup(qid)
    except JudgeError:
        raise
    except KeyError as exc:
        raise JudgeError(ErrorCode.UNKNOWN_QID, f"题库没有 {qid}") from exc
    except Exception as exc:   # lookup 实现方抛别的也在语义上算"查不到"
        raise JudgeError(ErrorCode.UNKNOWN_QID, f"无法解析 qid {qid}: {exc}") from exc
    return judge(raw_answer, answer_type=answer_type, canonical=canonical)
