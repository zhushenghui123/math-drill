"""modules/picker/module.py —— 选题器的**对外门面**（P2b）。

算法本体在 **`core/picker.py`**：依赖矩阵禁止 `bridge → modules`（bridge 是传输层、模块靠 registry 插拔），
而 `bridge/api.py::daily_questions` 必须直接选题 ⇒ 算法住 core；这里只做**再导出**，
将来给 picker 开 rpc（`modules/picker/manifest.json` 的 phase 2b）时，本模块就是那层包装。
"""

from core.picker import REVIEW_RATIO, chapter_of, pick  # noqa: F401  （对外门面，保持稳定导入路径）

__all__ = ["REVIEW_RATIO", "chapter_of", "pick"]
