#!/usr/bin/env bash
# scripts/rate_watch.sh —— 跑批看门狗：每 10 分钟把一次状态快照追加到日志（决策人 2026-10-08 要求）
#
# 为什么需要它：跑批是**后台长任务**，而它的失败形态是"静默丢批"（502 之后产物只是变少、不报错）。
# 定期留一行快照，事后能看出"哪一分钟开始不对劲"，而不是等跑完才发现少了几百题。
#
# 用法：
#   bash scripts/rate_watch.sh          # 前台每 600 秒记一次（Ctrl-C 退出）
#   setsid nohup bash scripts/rate_watch.sh > /dev/null 2>&1 < /dev/null &   # 后台
#
# 环境变量：INTERVAL（默认 600 秒）· LOG（快照日志，默认 data/candidates/rate-watch.log）
set -uo pipefail

cd "$(dirname "$0")/.."
INTERVAL="${INTERVAL:-600}"
LOG="${LOG:-$PWD/data/candidates/rate-watch.log}"
BOOKS="${BOOKS:-jmdw-gailv tongji-jiaocai-1 tongji-jiaocai-2 tongji-quanjie-1 tongji-quanjie-2 zheda-jiaocai zheda-quanjie}"

snapshot() {
  local total=0 line="[$(date '+%m-%d %H:%M:%S')]"
  for b in $BOOKS; do
    local f="data/candidates/$b.hybrid.kpid.rated.partial.jsonl"
    local n=0
    [ -f "$f" ] && n="$(wc -l < "$f")"
    total=$((total + n))
    line="$line $b=$n"
  done
  local procs fails
  procs="$(pgrep -fc 'rate_practiceable[.]py' 2>/dev/null || echo 0)"
  fails="$(grep -c '⚠️ 批次' data/candidates/rate-7books.log 2>/dev/null || echo 0)"
  line="$line | 合计=$total | 判定进程=$procs | 累计失败批次=$fails"
  echo "$line" >> "$LOG"
  echo "$line"
}

echo "=== 看门狗启动 $(date '+%F %T') · 每 ${INTERVAL}s 一次 → $LOG" >> "$LOG"
while true; do
  snapshot
  sleep "$INTERVAL"
done
