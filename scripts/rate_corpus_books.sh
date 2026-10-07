#!/usr/bin/env bash
# 语料题「可练性 + 难度」跑批（2026-10-07 —— 订阅到期日一次性跑完）
#
# 范围：9 本 6071 题（含 xiandai —— 09-23 只判过可练性、无难度；旧产物已备份到
#       data/candidates/backup-xiandai-v1-20261007/，否则 --resume 会读旧 partial 直接跳过）。
# 形态：逐本、大 → 小；每本最多 4 轮自动续跑（失败批只丢自己，轮内 --resume 收敛；无进展即停）。
# 产出：只写候选文件（*.rated.json + *.rated.partial.jsonl），**不入库**（入库 = 后续 import 步骤）。
#
# 用法：setsid nohup bash scripts/rate_corpus_books.sh >/dev/null 2>&1 </dev/null &
set -u
cd "$(dirname "$0")/.."

LOG=data/candidates/rate-all-latest.log
exec >>"$LOG" 2>&1

export OPENCODE_API_KEY="$(python3 - <<'PY'
import json, os
p = os.path.expanduser("~/.config/opencode/opencode.json")
print(json.load(open(p))["provider"]["opencode-go"]["options"]["apiKey"])
PY
)"
[ -n "$OPENCODE_API_KEY" ] || { echo "❌ 拿不到 OPENCODE_API_KEY，中止（$(date '+%F %T')）"; exit 1; }

BOOKS=(
  jmdw-gaoshu        # 1338
  tongji-quanjie-1   #  756
  tongji-jiaocai-1   #  677
  jmdw-xiandai       #  676（重判：补难度）
  jmdw-gailv         #  641
  zheda-jiaocai      #  579
  tongji-jiaocai-2   #  567
  tongji-quanjie-2   #  526
  zheda-quanjie      #  311
)
echo ""
echo "=== 跑批开始 $(date '+%F %T') · ${#BOOKS[@]} 本 ==="

for b in "${BOOKS[@]}"; do
  f="data/candidates/$b.hybrid.kpid.json"
  partial="data/candidates/$b.hybrid.kpid.rated.partial.jsonl"
  tot=$(python3 -c "import json;print(len(json.load(open('$f'))['questions']))")
  echo "=== $b 开始：$tot 题（$(date '+%T')）==="
  prev=-1
  for pass in 1 2 3 4; do
    t0=$SECONDS
    python3 scripts/rate_practiceable.py --candidates "$f" \
        --batch 10 --concurrency 12 --resume --apply
    cov=$(python3 - "$partial" <<'PY'
import json, sys
from pathlib import Path
p = Path(sys.argv[1]); d = {}
if p.exists():
    for line in p.read_text(encoding="utf-8").splitlines():
        if line.strip():
            r = json.loads(line); d[r["idx"]] = r
print(sum(1 for v in d.values() if isinstance(v.get("difficulty"), int) and 1 <= v["difficulty"] <= 4))
PY
)
    echo "    第 $pass 轮：覆盖 $cov/$tot（$((SECONDS - t0))s）"
    if [ "$cov" -ge "$tot" ]; then echo "✅ $b 收敛：$cov/$tot（$pass 轮）"; break; fi
    if [ "$cov" -le "$prev" ]; then echo "⚠️ $b 第 $pass 轮无进展（$cov/$tot），停止续跑，留人工"; break; fi
    prev=$cov
  done
  if [ "$cov" -lt "$tot" ]; then echo "⚠️ $b 跑完 4 轮仍未收敛：$cov/$tot"; fi
done
echo "=== 全部完成 $(date '+%F %T') ==="
