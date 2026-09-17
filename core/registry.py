"""core/registry.py —— 清单扫描与装载：**全仓唯一的动态装载点**（ARCHITECTURE §11.4.1）。

为什么豁免依赖纪律：core 不许静态 import 模块（铁律 1），但总得有人把模块装起来。
本文件是那个唯一例外，且必须满足三条（§11.4.1）：
  ① 只有这里出现 importlib（由 tests/test_dep_rules.py 机械检查）
  ② 装载路径逐个来自 manifest（不硬编码模块名）
  ③ 清单校验不过 → 直接冒泡（启动即失败，不给静默）

校验（MODULE_TEMPLATE §4 的生命周期）：name==目录名 / phase ≤ 当前阶段 /
enabled 与 config/modules.toml 合并（**表优先**）/ deps ⊆ {core, events} /
events_emit ⊆ contracts.events 枚举。
"""

from __future__ import annotations

import importlib.util
import json
import tomllib
from pathlib import Path
from types import ModuleType

from contracts.events import names as event_names

__all__ = ["Registry", "ManifestError", "PHASES", "load_module_from_manifest"]

REPO = Path(__file__).resolve().parent.parent

#: 阶段序（"2a" 在 "2b" 之前；装载时只放行 ≤ 当前阶段）
PHASES = ("1", "2a", "2b", "3", "4", "5")


class ManifestError(Exception):
    """清单不合规 → 启动失败（不给静默）。"""


def _phase_rank(phase: str) -> int:
    if phase not in PHASES:
        raise ManifestError(f"未知 phase: {phase!r}（合法值 {PHASES}）")
    return PHASES.index(phase)


def load_module_from_manifest(manifest_path: Path, manifest: dict) -> ModuleType:
    """按清单装载模块逻辑：`module.py`（模块）或 `generator.py`（题源）。

    两个候选名都是"约定文件名"，路径仍**来自清单所在目录**（不硬编码模块名）。

    这是本仓唯一的动态装载动作——`test_dep_rules.py` 会检查 importlib 只出现在本文件。
    """
    mdir = manifest_path.parent
    py = next((mdir / n for n in ("module.py", "generator.py") if (mdir / n).exists()), None)
    if py is None:
        raise ManifestError(f"{mdir.name} 缺逻辑文件（应为 module.py 或 generator.py）")
    spec = importlib.util.spec_from_file_location(
        f"math_drill_module_{manifest['name']}", py
    )
    if spec is None or spec.loader is None:
        raise ManifestError(f"无法为 {py} 构造 loader")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Registry:
    """扫描 modules/ 与 generators/，按清单校验并装载。"""

    def __init__(self, repo: Path | str = REPO, *, phase: str = "1") -> None:
        self.repo = Path(repo)
        self.phase = phase
        self._rank = _phase_rank(phase)
        self.toggles = self._read_toggles()
        self.loaded: dict[str, ModuleType] = {}
        self.skipped: dict[str, str] = {}
        self.manifests: dict[str, dict] = {}

    # ------------------------------------------------------------ 配置
    def _read_toggles(self) -> dict:
        cfg = self.repo / "config" / "modules.toml"
        if not cfg.exists():
            return {}
        with open(cfg, "rb") as f:
            return dict(tomllib.load(f).get("modules", {}))

    # ------------------------------------------------------------ 校验
    def _validate(self, manifest: dict, mdir: Path) -> None:
        name = manifest.get("name")
        if name != mdir.name:
            raise ManifestError(f"{mdir}/manifest.json 的 name={name!r} 与目录名不一致")
        for key in ("name", "phase", "enabled", "description"):
            if key not in manifest:
                raise ManifestError(f"{mdir}/manifest.json 缺必填字段 {key}")
        _phase_rank(manifest["phase"])                      # phase 合法性
        for dep in manifest.get("deps", []):
            if dep != "core" and dep not in event_names():
                raise ManifestError(
                    f"{name}: deps 只许 'core' 或事件名（events.py 枚举），非法项 {dep!r}"
                )
        for ev in manifest.get("events_emit", []):
            if ev not in event_names():
                raise ManifestError(f"{name}: events_emit 含未注册事件 {ev!r}（contracts/events.py）")

    def _is_enabled(self, manifest: dict) -> bool:
        """启停表优先于 manifest 的 enabled（MODULE_TEMPLATE §2）。"""
        toggle = self.toggles.get(manifest["name"])
        return bool(manifest["enabled"] if toggle is None else toggle)

    # ------------------------------------------------------------ 装载
    def load_all(self) -> dict[str, ModuleType]:
        for root in ("modules", "generators"):
            base = self.repo / root
            if not base.exists():
                continue
            for mdir in sorted(p for p in base.iterdir() if p.is_dir()):
                if mdir.name.startswith((".", "_")) or mdir.name in {"tests", "docs"}:
                    continue
                mpath = mdir / "manifest.json"
                if not mpath.exists():
                    raise ManifestError(f"{root}/{mdir.name} 缺 manifest.json")
                manifest = json.loads(mpath.read_text(encoding="utf-8"))
                self._validate(manifest, mdir)
                key = f"{root}/{mdir.name}"
                if _phase_rank(manifest["phase"]) > self._rank:
                    self.skipped[key] = f"phase {manifest['phase']} > 当前 {self.phase}"
                    continue
                if not self._is_enabled(manifest):
                    self.skipped[key] = "enabled=false（启停表或清单）"
                    continue
                self.manifests[key] = manifest
                self.loaded[key] = load_module_from_manifest(mpath, manifest)
        return self.loaded

    # ------------------------------------------------------------ 查询
    def rpcs(self) -> dict[str, list[str]]:
        return {k: list(m.get("rpc", [])) for k, m in self.manifests.items()}

    def dispatch(self, key: str, rpc_name: str, payload: dict, ctx):
        """调模块回调：`/m/<module>/<rpc>` 的落点（bridge 调用）。"""
        mod = self.loaded.get(key)
        if mod is None:
            raise KeyError(f"模块未装载：{key}（可能 phase 未到或 enabled=false）")
        if rpc_name not in self.manifests[key].get("rpc", []):
            raise KeyError(f"{key} 未声明 rpc {rpc_name!r}")
        handler = getattr(mod, "on_request", None)
        if handler is None:
            raise KeyError(f"{key}/module.py 未实现 on_request（MODULE_TEMPLATE §3 要求显式 noop）")
        return handler(rpc_name, payload, ctx)
