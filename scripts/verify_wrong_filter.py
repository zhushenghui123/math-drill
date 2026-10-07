"""复核方行为验证：qbank `wrong` 筛选判据 + done/wrong 布尔（只读，临时库，不碰生产）。

跑法：PYTHONDONTWRITEBYTECODE=1 python3 /tmp/check_wrong_filter.py
覆盖：判据语义（做过且从没做对过）、bool/字符串两形态、组合筛选、不变量 wrong⇒done。
"""
from __future__ import annotations

import sys
from pathlib import Path
from tempfile import TemporaryDirectory

REPO = Path("/home/myuser/workspaces/DeepSeek/math-drill")
sys.path.insert(0, str(REPO))

from core.registry import Registry  # noqa: E402
from core.store import Store  # noqa: E402

KP = [
    {"id": "c1n2", "title": "两个重要极限（一）", "chapter": "第一章 函数、极限与连续",
     "subject": "calculus", "exam": "all", "related": None},
    {"id": "l1n1", "title": "行列式的性质与计算", "chapter": "第一章 行列式",
     "subject": "linear", "exam": "all", "related": None},
    {"id": "l2n1", "title": "矩阵的运算", "chapter": "第九章 矩阵",
     "subject": "linear", "exam": "all", "related": None},
]


def Q(qid, kid):
    return {"id": qid, "kid": kid, "type": "blank", "answer_type": "rational",
            "stem": "题干 " + qid, "answer": "1", "analysis": "x", "difficulty": 2,
            "source": "review-probe"}


Q1, Q2, Q3, Q4 = (Q("probe.q1", "c1n2"), Q("probe.q2", "l1n1"),
                  Q("probe.q3", "c1n2"), Q("probe.q4", "l2n1"))
W, R = {"verdict": "server_false", "correct": False}, {"verdict": "server_true", "correct": True}

fails = 0


def check(label, got, want):
    global fails
    ok = got == want
    if not ok:
        fails += 1
    print(("  PASS  " if ok else "  FAIL  ") + label + ("" if ok else f"  got={got!r} want={want!r}"))


td = TemporaryDirectory()
store = Store(td.name)
store.load_kp(KP)
store.load_questions([Q1, Q2, Q3, Q4])
store.record_attempt(qid=Q1["id"], kid="c1n2", result=W)   # Q1：两次都错
store.record_attempt(qid=Q1["id"], kid="c1n2", result=W)
store.record_attempt(qid=Q2["id"], kid="l1n1", result=W)   # Q2：先错后对（关键边界）
store.record_attempt(qid=Q2["id"], kid="l1n1", result=R)
store.record_attempt(qid=Q4["id"], kid="l2n1", result=R)   # Q4：只对过
# Q3：零作答

reg = Registry(REPO, phase="1")
reg.load_all()


def call(payload):
    return reg.dispatch("modules/qbank", "list", payload, ctx=store)


def ids(payload):
    return sorted(i["qid"] for i in call(payload)["items"])


def flags(qid):
    it = [i for i in call({})["items"] if i["qid"] == qid][0]
    return (it.get("done"), it.get("wrong"))


ALL = sorted([Q1["id"], Q2["id"], Q3["id"], Q4["id"]])
print("== wrong 筛选判据（Q1 全错 / Q2 先错后对 / Q3 未做 / Q4 只对）==")
check("不带筛选 → 全部 4 题", ids({}), ALL)
check("wrong=None 显式 → 全部 4 题（不过滤）", ids({"wrong": None}), ALL)
check("wrong=True → 恰好 Q1（做过且从没做对过）", ids({"wrong": True}), [Q1["id"]])
check('wrong="true"（查询串形态）→ Q1', ids({"wrong": "true"}), [Q1["id"]])
check("wrong=False → Q2/Q3/Q4（错过但做对过的不算错）", ids({"wrong": False}), sorted([Q2["id"], Q3["id"], Q4["id"]]))
check('wrong="false" → 同上', ids({"wrong": "false"}), sorted([Q2["id"], Q3["id"], Q4["id"]]))
check('wrong="banana"（认不出）→ 不过滤（不猜）', ids({"wrong": "banana"}), ALL)
check("done=False（前端 JSON 布尔原样进来）→ 未做 Q3", ids({"done": False}), [Q3["id"]])
check("wrong=True + subject=calculus → Q1", ids({"wrong": True, "subject": "calculus"}), [Q1["id"]])
check("wrong=False + subject=linear → Q2/Q4", ids({"wrong": False, "subject": "linear"}), sorted([Q2["id"], Q4["id"]]))
check("不变量：wrong=True + done=False → 空集", ids({"wrong": True, "done": False}), [])

print("== 条目自带 done/wrong 布尔 ==")
check("Q1 (done, wrong)", flags(Q1["id"]), (True, True))
check("Q2 (done, wrong) 先错后对 ⇒ wrong=False", flags(Q2["id"]), (True, False))
check("Q3 (done, wrong) 未做 ⇒ 两个都 False", flags(Q3["id"]), (False, False))
check("Q4 (done, wrong)", flags(Q4["id"]), (True, False))

store.close()
td.cleanup()
print("\n" + ("✅ 全部通过（16 项）" if not fails else f"❌ 失败 {fails} 项"))
sys.exit(1 if fails else 0)
