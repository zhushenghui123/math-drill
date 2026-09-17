#!/bin/sh
# scripts/backup_check.sh —— 在线备份 + integrity_check → /var/backups/math-drill
#
# 由 deploy/backup.timer → deploy/backup.service 触发（ARCHITECTURE §12.3）。
# 失败处理：退出码非 0 即写日志（**不做告警推送**——决策人明确不要推送类功能）。
#
# 为什么用 `python3 -c` 而不是 `sqlite3` 命令行：**目标主机上没有装 sqlite3 CLI**
# （2026-09-17 实测），而 Python 标准库自带 sqlite3 且它就在机器上（服务端零依赖的前提）。
# `Connection.backup()` 就是官方的在线备份 API —— 不是自己造轮子。
set -eu

DATA_DIR="${MATH_DRILL_DATA_DIR:-/var/lib/math-drill}"
BACKUP_DIR="${MATH_DRILL_BACKUP_DIR:-/var/backups/math-drill}"
KEEP="${MATH_DRILL_BACKUP_KEEP:-7}"
DB="$DATA_DIR/math-drill.db"

if [ ! -f "$DB" ]; then
    echo "backup_check: 找不到数据库 $DB" >&2
    exit 1
fi

mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
TARGET="$BACKUP_DIR/math-drill-$STAMP.db"

python3 -c '
import sqlite3, sys
src_path, dst_path = sys.argv[1], sys.argv[2]
src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True)
dst = sqlite3.connect(dst_path)
with dst:
    src.backup(dst)
check = dst.execute("PRAGMA integrity_check").fetchone()[0]
dst.close(); src.close()
if check != "ok":
    print(f"backup_check: integrity_check 失败：{check}", file=sys.stderr)
    sys.exit(1)
' "$DB" "$TARGET"

# 轮转：按时间倒序，保留最近 $KEEP 份，其余删除
INDEX=0
for OLD in $(ls -1t "$BACKUP_DIR"/math-drill-*.db 2>/dev/null || true); do
    INDEX=$((INDEX + 1))
    if [ "$INDEX" -gt "$KEEP" ]; then
        rm -f "$OLD"
    fi
done

echo "backup_check: ok → $TARGET（保留最近 $KEEP 份）"
