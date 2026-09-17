"""contracts/events.py —— registry 事件名枚举：**唯一真值**（docs 里的注解只是人话）。

纪律（ARCHITECTURE §11.6）：
  - 本枚举是事件名的唯一真值；模块 manifest 的 `events_emit` 必须 ⊆ 本枚举，否则 registry 启动即失败。
  - registry 扫描时也不认字面量：事件名一律从这里取。
  - 事件改名 → 本文件与所有使用点同 commit 变更，`tests/test_dep_rules.py` 随之红/绿。
  - **当前阶段（T0）事件集为空**：第一个事件由第一个真正使用它的模块在同 commit 追加，
    不预先发明（避免造出没人发的"死事件"）。
"""

from enum import Enum


class Events(str, Enum):
    """registry 事件名注册表。

    命名规则：`<域>.<对象>.<过去式动词>`，全小写点分（例：`practice.answer.recorded`）。
    T0 为空枚举——新增即在此追加一行，并在模块 manifest 声明 `events_emit`。
    """

    # 例：ANSWER_RECORDED = "practice.answer.recorded"   # 由 modules/practice 落地时追加


def names() -> set[str]:
    """返回当前合法事件名集合（registry 与测试都用它校验，不认字面量）。"""
    return {e.value for e in Events}
