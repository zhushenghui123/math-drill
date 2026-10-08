#!/usr/bin/env bash
# scripts/verify_and_import.sh —— 跑批收尾三件：**核对条数 → 补齐缺口 → 灌库**
#
# 为什么需要它（本轮踩到的两条）：
#   ① 跑批的失败形态是**静默丢批**（502 之后产物只是变少、不报错）⇒ 必须以"产物条数 vs 锚点数"为准；
#   ② **被中断的书不会写最终 `.rated.json`**（最终装配在 `rate_practiceable.py` 跑完那一刻才落盘）
#      ⇒ 只补 partial 不够，得把那一本**跑到自然结束**，否则灌库用的是旧文件。
#
# 用法：
#   bash scripts/verify_and_import.sh check                 # 只核对，打印每本"产物 / 锚点"
#   bash scripts/verify_and_import.sh fill                  # 对缺口书自动 `--resume` 跑到底（含写 rated）
#   bash scripts/verify_and_import.sh import <data-dir>     # 灌库（**数据目录必填**，防误写生产）
set -uo pipefail
cd "$(dirname "$0")/.."
export PYTHONDONTWRITEBYTECODE=1

MODEL="${MODEL:-longcat-2.5-preview-free}"
CONC="${CONC:-8}"
BOOKS="${BOOKS:-jmdw-gailv tongji-jiaocai-1 tongji-jiaocai-2 tongji-quanjie-1 tongji-quanjie-2 zheda-jiaocai zheda-quanjie}"

counts() {  # 每本：锚点数（候选文件里的题数）
  python3 - "$1" <<'PY'
import json, sys, pathlib
p = pathlib.Path(f"data/candidates/{sys.argv[1]}.hybrid.kpid.json")
print(len(json.loads(p.read_text(encoding="utf-8"))["questions"]) if p.exists() else 0)
PY
}

judged() {  # 每本：已判定条数（**按唯一 idx 去重** —— 补跑会让同一批重复追加行）
  local f="data/candidates/$1.hybrid.kpid.rated.partial.jsonl"
  [ -f "$f" ] || { echo 0; return; }
  python3 - "$f" <<'PY'
import json, sys
seen = set()
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.strip()
    if line:
        try:
            seen.add(json.loads(line)["idx"])
        except (ValueError, KeyError):
            pass
print(len(seen))
PY
}

report() {
  printf '%-20s %8s %8s %s\n' 书 已判定 锚点 状态
  local total=0 anchor=0 gap=0
  for b in $BOOKS; do
    local n a mark
    n="$(judged "$b")"; a="$(counts "$b")"
    total=$((total + n)); anchor=$((anchor + a))
    if [ "$n" -ge "$a" ]; then mark="✅ 齐"; else mark="⚠️ 缺 $((a - n))"; gap=$((gap + a - n)); fi
    printf '%-20s %8s %8s %s\n' "$b" "$n" "$a" "$mark"
  done
  printf '%-20s %8s %8s %s\n' 合计 "$total" "$anchor" "缺口 $gap"
}

case "${1:-check}" in
  check) report ;;
  fill)
    for b in $BOOKS; do
      if [ "$(judged "$b")" -lt "$(counts "$b")" ]; then
        echo "=== 补跑 $b（--resume，跑到自然结束才会写 .rated.json）"
        python3 scripts/rate_practiceable.py --candidates "data/candidates/$b.hybrid.kpid.json" \
          --batch 20 --concurrency "$CONC" --model "$MODEL" --apply --resume | tail -2
      fi
    done
    report ;;
  import)
    DIR="${2:?用法: verify_and_import.sh import <data-dir>}"
    for b in $BOOKS; do
      f="data/candidates/$b.hybrid.kpid.rated.json"
      [ -f "$f" ] || { echo "⚠️ 缺 $f（先跑 fill）"; continue; }
      python3 scripts/import_candidates.py --candidates "$f" --data-dir "$DIR" | head -1
    done ;;
  *) echo "用法: $0 [check|fill|import <data-dir>]"; exit 2 ;;
esac
