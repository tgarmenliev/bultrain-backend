#!/usr/bin/env bash
#
# ci-check.sh — fast, fixture-free checks that catch the common ways a change
# breaks the backend, before it reaches the server. Run locally with `npm test`
# and in GitHub Actions on every push.
#
set -euo pipefail
cd "$(dirname "$0")/.."

echo "1/5 · better-sqlite3 native module loads (the thing the Node 24 upgrade broke)"
node -e "const D=require('better-sqlite3'); const db=new D(':memory:'); db.exec('create table t(a)'); db.prepare('insert into t values(1)').run(); if(db.prepare('select a from t').get().a!==1) throw new Error('sanity'); console.log('    ok on', process.version)"

echo "2/5 · syntax check on all source files"
while IFS= read -r f; do node --check "$f"; done < <(
    find server.js controllers routes services database workers -name '*.js' 2>/dev/null
)
echo "    ok"

echo "3/5 · migrations apply cleanly from an empty database"
TMP="$(mktemp -u).sqlite"
node database/migrate.js "$TMP" >/dev/null
rm -f "$TMP" "$TMP"-* 2>/dev/null || true
echo "    ok"

echo "4/5 · station-aliases.json is valid JSON"
node -e "JSON.parse(require('fs').readFileSync('services/gtfs/station-aliases.json','utf8')); console.log('    ok')"

# The controllers open the DB (readonly, fileMustExist) at require() time, so a
# database must exist. Locally that's the dev DB; in CI we build an empty one.
CREATED_DB=0
if [ ! -f bultrain.sqlite ]; then
    node database/migrate.js bultrain.sqlite >/dev/null
    CREATED_DB=1
fi

echo "5/5 · every route module loads without throwing"
node -e "['./routes/live','./routes/trainInfo','./routes/schedule','./routes/stations','./routes/realtime','./routes/guide','./routes/admin'].forEach(r=>require(r)); console.log('    ok')"

if [ "$CREATED_DB" = 1 ]; then rm -f bultrain.sqlite bultrain.sqlite-* 2>/dev/null || true; fi

echo ""
echo "ALL CHECKS PASSED ✅"
