#!/bin/sh
# scripts/backup_check.sh —— sqlite3 .backup + integrity_check → /var/backups/math-drill
#
# 由 deploy/backup.timer → deploy/backup.service 触发（ARCHITECTURE §12.3）。
# 失败处理：退出码非 0 即写日志（**不做告警推送**——决策人明确不要推送类功能）。
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

# .backup 是 SQLite 官方的在线备份入口（不会拿到半个事务）
sqlite3 "$DB" ".backup '$TARGET'"

CHECK=$(sqlite3 "$TARGET" "PRAGMA integrity_check;")
if [ "$CHECK" != "ok" ]; then
    echo "backup_check: integrity_check 失败：$CHECK" >&2
    exit 1
fi

# 轮转：按时间倒序，保留最近 $KEEP 份，其余删除
INDEX=0
for OLD in $(ls -1t "$BACKUP_DIR"/math-drill-*.db 2>/dev/null || true); do
    INDEX=$((INDEX + 1))
    if [ "$INDEX" -gt "$KEEP" ]; then
        rm -f "$OLD"
    fi
done

echo "backup_check: ok → $TARGET（保留最近 $KEEP 份）"
