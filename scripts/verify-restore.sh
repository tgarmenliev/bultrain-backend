#!/usr/bin/env bash
#
# verify-restore.sh — prove the latest backup actually restores.
#
# A backup is only real once you have restored it somewhere and seen the data.
# This restores the newest .gz into a throwaway file, runs integrity_check, and
# prints the row counts. It never touches the live database.
#
set -euo pipefail

BACKUP_DIR="${BULTRAIN_BACKUP_DIR:-/root/backups}"

latest="$(ls -1t "$BACKUP_DIR"/bultrain-*.sqlite.gz 2>/dev/null | head -1 || true)"
[ -n "$latest" ] || { echo "No backups found in $BACKUP_DIR" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Restoring: $latest"
gunzip -c "$latest" > "$tmp/restored.sqlite"

echo -n "integrity_check: "
sqlite3 "$tmp/restored.sqlite" "PRAGMA integrity_check;"

echo "row counts:"
sqlite3 "$tmp/restored.sqlite" "
  SELECT '  schedules       ' || COUNT(*) FROM schedules
  UNION ALL SELECT '  trains          ' || COUNT(*) FROM trains
  UNION ALL SELECT '  stations        ' || COUNT(*) FROM stations
  UNION ALL SELECT '  handbook_topics ' || COUNT(*) FROM handbook_topics;
"
echo "restore verified."
