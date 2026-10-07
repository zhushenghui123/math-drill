"""tests/test_wrong_filter_behavior.py —— 收编复核方的行为验证（复核 S2）。

为什么要有它：本批后端给 `_list` 加了 `wrong` 筛选，但**当时零测试覆盖** —— 复核方独立写了
一份行为验证（原稿 `~/workspaces/claude/复核脚本-wrong筛选行为验证-20261007.py`，16/16 过），
覆盖"全错 / 先错后对 / 未做 / 只对"四态、`bool` 与字符串两形态、`"banana"` 不猜、
以及不变量 `wrong ⇒ done`。本文件把它**收编进仓库测试套件**（脚本本体入 `scripts/verify_wrong_filter.py`），
这样它随 `unittest discover` 一起跑，而不是躺在仓外靠人记得手动执行。

它只读、用临时库、不碰生产（原稿的纪律，照抄保留）。
"""

from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "scripts" / "verify_wrong_filter.py"


class WrongFilterBehaviorCase(unittest.TestCase):
    def test_behavior_script_is_adopted(self):
        self.assertTrue(SCRIPT.is_file(), f"行为脚本没入仓：{SCRIPT}")

    def test_behavior_script_passes(self):
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        proc = subprocess.run([sys.executable, str(SCRIPT)],
                              capture_output=True, text=True, env=env, timeout=120)
        out = (proc.stdout or "") + (proc.stderr or "")
        self.assertEqual(proc.returncode, 0, out)
        self.assertIn("全部通过", out)          # 脚本自己的收尾语
        self.assertIn("16 项", out)             # 覆盖面不许悄悄缩水


if __name__ == "__main__":
    unittest.main()
