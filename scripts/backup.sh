#!/usr/bin/env bash
#
# backup.sh — consistent, verified, rotated backup of the BulTrain SQLite DB.
#
# Safe to run against the live database: sqlite3 ".backup" uses SQLite's online
# backup API, which is consistent while the app keeps reading and writing in WAL
# mode. A plain `cp` is NOT safe — it can miss committed transactions still in
# the -wal file. Never replace this with cp.
#
# Driven by systemd timer (see deploy/systemd/). Override any of the vars below
# via the environment / the systemd unit.
#
set -euo pipefail

DB_PATH="${BULTRAIN_DB:-/root/bultrain-app/bultrain.sqlite}"
BACKUP_DIR="${BULTRAIN_BACKUP_DIR:-/root/backups}"
# 30 backups = 30 days of history at the daily interval.
RETENTION="${BULTRAIN_BACKUP_RETENTION:-30}"
# Optional off-box target: an rclone remote, e.g. a Backblaze B2 bucket:
#   BULTRAIN_BACKUP_REMOTE="b2:my-bucket/bultrain"
# The rclone remote (its keys) is configured on the box, never in git.
REMOTE="${BULTRAIN_BACKUP_REMOTE:-}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
fail() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] FATAL: $*" >&2; exit 1; }

[ -f "$DB_PATH" ] || fail "database not found at $DB_PATH"
mkdir -p "$BACKUP_DIR"

ts="$(date +%Y%m%d-%H%M%S)"
dest="$BACKUP_DIR/bultrain-$ts.sqlite"

# 1. Consistent online snapshot.
sqlite3 "$DB_PATH" ".backup '$dest'" || fail "sqlite .backup failed"

# 2. A backup you have not verified is not a backup.
check="$(sqlite3 "$dest" 'PRAGMA integrity_check;')"
[ "$check" = "ok" ] || { rm -f "$dest"; fail "integrity_check failed: $check"; }
rows="$(sqlite3 "$dest" 'SELECT COUNT(*) FROM schedules;')"

# 3. Compress (SQLite compresses well).
gzip -f "$dest"
log "wrote ${dest}.gz  (schedules=$rows)"

# 4. Rotate: keep the newest $RETENTION, drop the rest.
removed="$(ls -1t "$BACKUP_DIR"/bultrain-*.sqlite.gz 2>/dev/null | tail -n +"$((RETENTION + 1))" | tee >(xargs -r rm -f) | wc -l | tr -d ' ')"
[ "$removed" = "0" ] || log "rotated out $removed old backup(s)"

# 5. Off-box copy — the step that makes it survive a dead disk.
# `rclone copy` only uploads new files; it never deletes on the remote, so the
# off-box side keeps full history even though the local side rotates at 30. A
# footgun avoided: `sync` would mirror deletions, so an empty local dir would
# wipe the remote. copy cannot.
if [ -n "$REMOTE" ]; then
    command -v rclone >/dev/null 2>&1 || fail "BULTRAIN_BACKUP_REMOTE set but rclone is not installed"
    rclone copy "$BACKUP_DIR" "$REMOTE" --include 'bultrain-*.sqlite.gz' \
        && log "copied to $REMOTE" || fail "off-box rclone copy to $REMOTE failed"
else
    log "WARNING: BULTRAIN_BACKUP_REMOTE unset — backups are on the same disk as the DB"
fi

log "backup ok"
