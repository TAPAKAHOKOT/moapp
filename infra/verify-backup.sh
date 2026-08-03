#!/bin/sh
set -eu

restore_db=/restore/moapp.sqlite
rm -f "$restore_db" "$restore_db-wal" "$restore_db-shm"

litestream restore \
  -config /etc/litestream.yml \
  -force \
  -o "$restore_db" \
  /data/moapp.sqlite

result="$(sqlite3 "$restore_db" 'PRAGMA quick_check;')"
if [ "$result" != "ok" ]; then
  echo "Restored SQLite backup failed PRAGMA quick_check: $result" >&2
  exit 1
fi

if ! heartbeat="$(sqlite3 "$restore_db" "SELECT value FROM app_meta WHERE key = 'backup_heartbeat' LIMIT 1;" 2>/dev/null)"; then
  echo "Backup freshness check failed: app_meta/backup_heartbeat is unavailable (the backup may predate heartbeat support)." >&2
  exit 1
fi

if [ -z "$heartbeat" ]; then
  echo "Backup freshness check failed: app_meta key backup_heartbeat is missing." >&2
  exit 1
fi

heartbeat_epoch="$(sqlite3 "$restore_db" "SELECT unixepoch(value) FROM app_meta WHERE key = 'backup_heartbeat' LIMIT 1;")"
case "$heartbeat_epoch" in
  ''|*[!0-9]*)
    echo "Backup freshness check failed: backup_heartbeat is not a valid ISO timestamp: $heartbeat" >&2
    exit 1
    ;;
esac

now_epoch="$(date -u +%s)"
age_seconds=$((now_epoch - heartbeat_epoch))
max_age_seconds=172800

if [ "$age_seconds" -gt "$max_age_seconds" ]; then
  echo "Backup freshness check failed: heartbeat $heartbeat is older than 48 hours (age: ${age_seconds}s)." >&2
  exit 1
fi

echo "Backup restore verification succeeded (SQLite quick_check: ok; heartbeat: $heartbeat)."
