#!/usr/bin/env bash
#
# gtfs-refresh.sh — one full GTFS static refresh.
#
# Downloads the latest NAP feed, loads the raw tables, rebuilds the crosswalk,
# fixes station coordinates, and materialises the date-based serving tables.
# Every step writes inside a transaction, so the live server (readonly, WAL)
# keeps serving the previous data until each step commits — no downtime.
#
# Used both for the initial population and by the daily systemd timer.
#
# Usage:  scripts/gtfs-refresh.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

DB="${BULTRAIN_DB:-$PWD/bultrain.sqlite}"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "GTFS refresh starting (db=$DB)"

log "1/5 migrate";                node database/migrate.js "$DB"
log "2/5 download + import feed";  node services/gtfs/import-raw.js "$DB"
log "3/5 crosswalk";               node services/gtfs/build-crosswalk.js "$DB" >/dev/null
log "3/5 reconcile coordinates";   node services/gtfs/reconcile-coords.js "$DB" --apply >/dev/null
log "4/5 crosswalk (rebuild)";     node services/gtfs/build-crosswalk.js "$DB" >/dev/null
log "5/5 materialize";             node services/gtfs/materialize.js "$DB"

log "GTFS refresh done"
