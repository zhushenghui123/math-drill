#!/usr/bin/env bash
# scripts/rate_batch.sh —— 批量跑「可练性判定 + agent 难度」（`rate_practiceable.py` 的外壳）
#
# 为什么有它：跑一批书要"逐本串行 + 每本可断点续跑 + 统一日志"，一行一行敲容易漏 `--resume`；
# 而且**并发与批量大小要可调**（上游 502 的容忍度决定上限，见下）。
#
# 用法：
#   bash scripts/rate_batch.sh                     # 默认：剩余 7 本 · LongCat 免费 · batch 20 · 并发 16
#   BOOKS="jmdw-gailv" CONC=8 BATCH=10 bash scripts/rate_batch.sh
#   MODEL=deepseek-v4.1-flash bash scripts/rate_batch.sh
#
# ⚠️ 上游容错（本项目踩过）：opencode 上游会偶发 **502**，脚本会打印 `⚠️ 批次 N 失败` 并继续；
#    **失败不报错、产物会静默变少** —— 所以跑完必须核对"产物条数 vs 锚点数"，缺的用 `--resume` 补跑。
#    并发不是越大越好：改大后要看 `grep -c "⚠️ 批次" 日志` 的失败率，失败率飙升反而更慢。
set -uo pipefail

cd "$(dirname "$0")/.."
export PYTHONDONTWRITEBYTECODE=1

MODEL="${MODEL:-longcat-2.5-preview-free}"
BATCH="${BATCH:-20}"
CONC="${CONC:-16}"
LOG="${LOG:-$PWD/data/candidates/rate-7books.log}"
BOOKS="${BOOKS:-jmdw-gailv tongji-jiaocai-1 tongji-jiaocai-2 tongji-quanjie-1 tongji-quanjie-2 zheda-jiaocai zheda-quanjie}"

echo "=== 跑批开始 $(date '+%F %T') · model=$MODEL batch=$BATCH conc=$CONC" >> "$LOG"
for b in $BOOKS; do
  echo "=== START $b $(date '+%m-%d %H:%M:%S')" >> "$LOG"
  python3 scripts/rate_practiceable.py \
    --candidates "data/candidates/$b.hybrid.kpid.json" \
    --batch "$BATCH" --concurrency "$CONC" --model "$MODEL" --apply --resume >> "$LOG" 2>&1
  echo "=== END $b rc=$? $(date '+%m-%d %H:%M:%S')" >> "$LOG"
done
echo "=== ALL DONE $(date '+%F %T')" >> "$LOG"
