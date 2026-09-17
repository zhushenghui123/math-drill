"""scripts/gen_bundles.py —— 扫描 `generators/` → `data/bundle-vN.json`（ARCHITECTURE §10.D）。

用法：
    python3 scripts/gen_bundles.py --seed 20260917 --per-family 6 --out data/bundle-v1.json

两条纪律：
  · **可复现门**：同 seed 同字节（文件里不写时间戳——那是"同 seed 同输出"的敌人）
  · **装载走唯一通道**：生成器一律经 `core.registry.load_module_from_manifest` 装载，
    不在这里自己 importlib（§11.4.1：全仓唯一的动态装载点）
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from core.registry import load_module_from_manifest  # noqa: E402


def collect(repo: Path, *, seed: int, per_family: int, phase: str = "1") -> list[dict]:
    """装载所有 enabled 且 ≤phase 的生成器，收集题目（顺序固定 → 可复现）。"""
    from core.registry import Registry

    reg = Registry(repo, phase=phase)
    reg.load_all()
    questions: list[dict] = []
    for key, mod in sorted(reg.loaded.items()):
        if not key.startswith("generators/"):
            continue
        gen = getattr(mod, "generate", None)
        if gen is None:
            print(f"  跳过 {key}：没有 generate()", file=sys.stderr)
            continue
        got = gen(seed=seed, per_family=per_family)
        print(f"  {key}: {len(got)} 题")
        questions.extend(got)
    return questions


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="生成题库 bundle（同 seed 同输出）")
    ap.add_argument("--seed", type=int, default=20260917)
    ap.add_argument("--per-family", type=int, default=6)
    ap.add_argument("--bundle-version", type=int, default=1)
    ap.add_argument("--out", default="data/bundle-v1.json")
    ap.add_argument("--repo", default=str(REPO))
    args = ap.parse_args(argv)

    repo = Path(args.repo)
    out = Path(args.out)
    if not out.is_absolute():
        out = repo / out

    print(f"扫描 {repo}/generators（seed={args.seed}, per_family={args.per_family}）")
    questions = collect(repo, seed=args.seed, per_family=args.per_family)
    if not questions:
        print("❌ 没有生成任何题目", file=sys.stderr)
        return 1

    ids = [q["id"] for q in questions]
    if len(ids) != len(set(ids)):
        print("❌ 题目 id 冲突（同 seed 内必须唯一）", file=sys.stderr)
        return 1

    bundle = {
        "bundle_version": args.bundle_version,
        "seed": args.seed,
        "count": len(questions),
        "questions": questions,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(bundle, f, ensure_ascii=False, sort_keys=True, indent=1)
        f.write("\n")
    print(f"✅ 写出 {out}（{len(questions)} 题，bundle_version={args.bundle_version}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
