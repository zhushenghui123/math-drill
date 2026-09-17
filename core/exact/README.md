# core/exact

精确算术（线性代数），全部基于 `fractions.Fraction`，**无浮点误差**。

- 来源：`linalg-drill/drill/exact.py`（454 行 / 30 项断言，已验证资产），T0.5 原样迁入。
- 为什么在 core：判定正确性属于内核（铁律 3）；`det/rank/rref` 供**判定与生成器共用**，
  故 `generators → core` 是合法依赖边（ARCHITECTURE §11.1 / §11.4）。
- 导出形式：`from core.exact import ...`（依赖 `__init__.py` 的再导出）。
- 验收：`python3.12 tests/test_exact.py` 与 `python3.14 tests/test_exact.py` 均 30 项断言全绿。
