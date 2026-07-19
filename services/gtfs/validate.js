'use strict';

/**
 * validate.js — detailed GTFS-vs-legacy comparison for a date, the confidence
 * check before flipping SCHEDULE_SOURCE to gtfs.
 *
 * Legacy side: exactly what the app serves today (day-of-week validity).
 * GTFS side: the FULL journey (train + replacement-bus legs combined), the way
 * the new serving layer resolves it.
 *
 * Per train number it reports one of: identical / time-differences /
 * stop-differences / only-in-GTFS (new) / only-in-legacy (dropped). Writes a
 * scrollable HTML with the exact per-stop detail so each case can be checked
 * against the live БДЖ site.
 *
 * Usage:  node services/gtfs/validate.js <YYYY-MM-DD> [db.sqlite] [--out file.html]
 */

const Database = require('better-sqlite3');
const fs       = require('fs');
const path     = require('path');

const { currentForDate } = require('./diff-report');

const DEFAULT_DB = path.join(__dirname, '..', '..', 'bultrain.sqlite');

function loadNames(db) {
    return new Map(db.prepare('SELECT id, name FROM stations').all().map(s => [s.id, s.name]));
}

// Full GTFS journey per train number on a date: all active trips, legs chained
// by time, the shared transfer station merged — same shape as serving.js.
function gtfsCombined(db, ymd) {
    const trips = db.prepare(`
        SELECT t.trip_id, t.train_number, t.category
        FROM trip t JOIN trip_date td ON td.trip_id = t.trip_id
        WHERE td.date = ?
    `).all(ymd);

    const stopStmt = db.prepare(
        'SELECT station_id, arrive, depart FROM trip_stop WHERE trip_id = ? ORDER BY seq'
    );
    const startMin = s => { const t = s.depart || s.arrive; if (!t) return 1e9; const [h, m] = t.split(':').map(Number); return h * 60 + m; };

    const byTrain = new Map();
    for (const t of trips) {
        if (!byTrain.has(t.train_number)) byTrain.set(t.train_number, []);
        byTrain.get(t.train_number).push({ category: t.category, stops: stopStmt.all(t.trip_id) });
    }

    const out = new Map();
    for (const [num, legs] of byTrain) {
        legs.sort((a, b) => startMin(a.stops[0]) - startMin(b.stops[0]));
        const merged = [];
        for (const leg of legs) {
            for (const s of leg.stops) {
                const prev = merged[merged.length - 1];
                if (prev && prev.station_id === s.station_id) { prev.depart = s.depart || prev.depart; continue; }
                merged.push({ station_id: s.station_id, arrive: s.arrive, depart: s.depart, category: leg.category });
            }
        }
        out.set(num, merged);
    }
    return out;
}

// Compare one train's two stop lists. Matches stops by station_id.
function compareTrain(legacy, gtfs) {
    const lIds = legacy.map(s => s.station_id);
    const gIds = gtfs.map(s => s.station_id);
    const lSet = new Set(lIds), gSet = new Set(gIds);

    const onlyLegacy = legacy.filter(s => !gSet.has(s.station_id));
    const onlyGtfs   = gtfs.filter(s => !lSet.has(s.station_id));

    // Time differences on stations present in both (compare where both non-null).
    const gByStation = new Map(gtfs.map(s => [s.station_id, s]));
    const timeDiffs = [];
    for (const l of legacy) {
        const g = gByStation.get(l.station_id);
        if (!g) continue;
        if (l.arrive && g.arrive && l.arrive !== g.arrive) timeDiffs.push({ station_id: l.station_id, field: 'пристига', from: l.arrive, to: g.arrive });
        if (l.depart && g.depart && l.depart !== g.depart) timeDiffs.push({ station_id: l.station_id, field: 'заминава', from: l.depart, to: g.depart });
    }

    let type;
    if (onlyLegacy.length === 0 && onlyGtfs.length === 0) type = timeDiffs.length ? 'time' : 'identical';
    else type = 'stops';
    return { type, onlyLegacy, onlyGtfs, timeDiffs };
}

function run(ymd, dbPath = DEFAULT_DB, outPath = null) {
    const db = new Database(dbPath, { readonly: true });
    const names = loadNames(db);
    const nm = id => names.get(id) || `#${id}`;

    const legacy = currentForDate(db, ymd);
    const gtfs   = gtfsCombined(db, ymd);
    db.close();

    const lTrains = new Set(legacy.keys()), gTrains = new Set(gtfs.keys());
    const buckets = { identical: [], time: [], stops: [], onlyGtfs: [], onlyLegacy: [] };

    for (const num of new Set([...lTrains, ...gTrains])) {
        if (!gTrains.has(num)) { buckets.onlyLegacy.push(num); continue; }
        if (!lTrains.has(num)) { buckets.onlyGtfs.push(num); continue; }
        const cmp = compareTrain(legacy.get(num), gtfs.get(num));
        buckets[cmp.type].push({ num, cmp });
    }

    // ── Console summary ──────────────────────────────────────────────────────
    const total = new Set([...lTrains, ...gTrains]).size;
    console.log(`\n══ VALIDATE ${ymd} — GTFS vs legacy ══\n`);
    console.log(`trains total (union):     ${total}`);
    console.log(`  identical:              ${buckets.identical.length}`);
    console.log(`  time differences only:  ${buckets.time.length}`);
    console.log(`  stop / route differ:    ${buckets.stops.length}`);
    console.log(`  only in GTFS (new):     ${buckets.onlyGtfs.length}  ${buckets.onlyGtfs.slice(0, 20).join(', ')}${buckets.onlyGtfs.length > 20 ? ' …' : ''}`);
    console.log(`  only in legacy (gone):  ${buckets.onlyLegacy.length}  ${buckets.onlyLegacy.slice(0, 20).join(', ')}${buckets.onlyLegacy.length > 20 ? ' …' : ''}`);

    // ── Detailed HTML ────────────────────────────────────────────────────────
    if (outPath) {
        const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
        let h = `<!doctype html><meta charset=utf8><title>GTFS validate ${ymd}</title><style>
body{font-family:system-ui;margin:2rem;max-width:1000px;color:#111}h1{margin-bottom:.2rem}
h2{margin-top:2rem;border-bottom:2px solid #ddd;padding-bottom:4px}
.train{margin:14px 0;padding:10px 14px;border:1px solid #ddd;border-radius:8px}
.num{font-weight:700;font-size:15px}.tag{font-size:12px;color:#fff;padding:2px 8px;border-radius:10px;margin-left:8px}
.t-time{background:#c60}.t-stops{background:#a33}
table{border-collapse:collapse;margin-top:6px}td,th{border:1px solid #ddd;padding:3px 9px;font-size:13px;text-align:left}
.gone{color:#a33}.new{color:#178}.small{color:#666;font-size:13px}</style>
<h1>GTFS ↔ legacy — ${ymd}</h1>
<p class=small>Всяка разлика долу може да се свери с живия сайт на БДЖ. GTFS е официалният свеж източник; "legacy" е това, което приложението сервира сега.</p>
<p class=small><b>${total}</b> влака · идентични <b>${buckets.identical.length}</b> · само времена <b>${buckets.time.length}</b> · спирки/маршрут <b>${buckets.stops.length}</b> · само GTFS <b>${buckets.onlyGtfs.length}</b> · само legacy <b>${buckets.onlyLegacy.length}</b></p>`;

        h += `<h2>Разлики в спирки / маршрут (${buckets.stops.length})</h2>`;
        for (const { num, cmp } of buckets.stops) {
            h += `<div class=train><span class=num>Влак ${esc(num)}</span><span class="tag t-stops">спирки</span>`;
            if (cmp.onlyLegacy.length) h += `<div class=small>Липсват в GTFS (има ги в legacy): <span class=gone>${cmp.onlyLegacy.map(s => esc(nm(s.station_id))).join(', ')}</span></div>`;
            if (cmp.onlyGtfs.length) h += `<div class=small>Нови в GTFS (няма ги в legacy): <span class=new>${cmp.onlyGtfs.map(s => esc(nm(s.station_id))).join(', ')}</span></div>`;
            if (cmp.timeDiffs.length) h += `<div class=small>+ ${cmp.timeDiffs.length} разлики във времена</div>`;
            h += `</div>`;
        }

        h += `<h2>Само разлики във времена (${buckets.time.length})</h2>`;
        for (const { num, cmp } of buckets.time) {
            h += `<div class=train><span class=num>Влак ${esc(num)}</span><span class="tag t-time">времена</span>`;
            h += `<table><tr><th>гара</th><th>поле</th><th>legacy</th><th>GTFS</th></tr>`;
            for (const d of cmp.timeDiffs) h += `<tr><td>${esc(nm(d.station_id))}</td><td>${d.field}</td><td>${esc(d.from)}</td><td>${esc(d.to)}</td></tr>`;
            h += `</table></div>`;
        }

        h += `<h2 class=new>Само в GTFS — нови влакове (${buckets.onlyGtfs.length})</h2><p class=small>${buckets.onlyGtfs.map(esc).join(', ') || '—'}</p>`;
        h += `<h2 class=gone>Само в legacy — липсват в GTFS (${buckets.onlyLegacy.length})</h2><p class=small>${buckets.onlyLegacy.map(esc).join(', ') || '—'}</p>`;

        fs.writeFileSync(outPath, h);
        console.log(`\nдетайлен HTML → ${outPath}`);
    }

    return buckets;
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const ymd = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
    const dbPath = args.find(a => a.endsWith('.sqlite')) || DEFAULT_DB;
    const oi = args.indexOf('--out');
    const outPath = oi >= 0 ? args[oi + 1] : null;
    if (!ymd) { console.error('usage: node services/gtfs/validate.js <YYYY-MM-DD> [db.sqlite] [--out file.html]'); process.exit(1); }
    run(ymd, dbPath, outPath);
}

module.exports = { run };
