'use strict';

/**
 * import-raw.js — load a GTFS static zip into the raw gtfs_* staging tables.
 *
 * Faithful 1:1 load: truncate + reload every gtfs_* table inside ONE
 * transaction, so a failure leaves the previously-loaded feed intact and
 * readers never see a half-loaded feed. Records provenance in gtfs_import.
 * Touches no serving table.
 *
 * Usage:  node services/gtfs/import-raw.js [feed.zip] [db.sqlite]
 *   (with no zip arg it downloads the latest first)
 */

const AdmZip   = require('adm-zip');
const Database = require('better-sqlite3');
const path     = require('path');

const { parseCsv }       = require('./csv');
const { downloadLatest } = require('./download');

const DEFAULT_DB = path.join(__dirname, '..', '..', 'bultrain.sqlite');

// table → { file, columns, num? }  — num lists columns coerced to Number.
const TABLES = {
    gtfs_agency: {
        file: 'agency.txt',
        columns: ['agency_id', 'agency_name', 'agency_url', 'agency_timezone', 'agency_lang', 'agency_phone'],
    },
    gtfs_stops: {
        file: 'stops.txt',
        columns: ['stop_id', 'stop_code', 'stop_name', 'stop_desc', 'stop_lat', 'stop_lon', 'zone_id', 'stop_url', 'location_type', 'parent_station', 'stop_timezone', 'wheelchair_boarding'],
        num: ['stop_lat', 'stop_lon'],
    },
    gtfs_routes: {
        file: 'routes.txt',
        columns: ['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_desc', 'route_type', 'route_url', 'route_color', 'route_text_color', 'route_sort_order'],
    },
    gtfs_trips: {
        file: 'trips.txt',
        columns: ['route_id', 'service_id', 'trip_id', 'trip_headsign', 'trip_short_name', 'direction_id', 'block_id', 'shape_id', 'wheelchair_accessible', 'bikes_allowed'],
    },
    gtfs_stop_times: {
        file: 'stop_times.txt',
        columns: ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence', 'stop_headsign', 'pickup_type', 'drop_off_type', 'shape_dist_traveled', 'timepoint'],
        num: ['stop_sequence'],
    },
    gtfs_calendar_dates: {
        file: 'calendar_dates.txt',
        columns: ['service_id', 'date', 'exception_type'],
        num: ['exception_type'],
    },
    gtfs_shapes: {
        file: 'shapes.txt',
        columns: ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence', 'shape_dist_traveled'],
        num: ['shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'],
    },
    gtfs_feed_info: {
        file: 'feed_info.txt',
        columns: ['feed_publisher_name', 'feed_publisher_url', 'feed_lang', 'feed_start_date', 'feed_end_date', 'feed_version', 'feed_contact_url'],
    },
};

function toNum(v) {
    if (v === '' || v == null) return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
}

function loadTable(db, zip, table, spec) {
    const entry = zip.getEntry(spec.file);
    if (!entry) throw new Error(`missing ${spec.file} in the feed`);

    const rows = parseCsv(entry.getData().toString('utf8'));
    const numSet = new Set(spec.num || []);

    const placeholders = spec.columns.map(() => '?').join(', ');
    const insert = db.prepare(
        `INSERT INTO ${table} (${spec.columns.join(', ')}) VALUES (${placeholders})`
    );

    db.prepare(`DELETE FROM ${table}`).run();
    for (const row of rows) {
        insert.run(spec.columns.map(c => (numSet.has(c) ? toNum(row[c]) : (row[c] ?? null))));
    }
    return rows.length;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.zipPath]  load this zip; if omitted, download latest
 * @param {string} [opts.dbPath]
 * @param {object} [opts.meta]     provenance ({id, filename, checksum}) when known
 * @returns {Promise<{counts, feedVersion, feedStart, feedEnd}>}
 */
async function importRaw({ zipPath, dbPath = DEFAULT_DB, meta } = {}) {
    let provenance = meta;
    if (!zipPath) {
        const dl = await downloadLatest();
        zipPath = dl.path;
        provenance = dl;
    }

    const zip = new AdmZip(zipPath);
    const db  = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    const counts = {};
    const load = db.transaction(() => {
        for (const [table, spec] of Object.entries(TABLES)) {
            counts[table] = loadTable(db, zip, table, spec);
        }

        const info = db.prepare('SELECT feed_version, feed_start_date, feed_end_date FROM gtfs_feed_info LIMIT 1').get() || {};
        db.prepare(`
            INSERT INTO gtfs_import (file_id, filename, checksum, feed_version, feed_start, feed_end, imported_at, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'ok')
        `).run(
            provenance?.id || null,
            provenance?.filename || path.basename(zipPath),
            provenance?.checksum || null,
            info.feed_version || null,
            info.feed_start_date || null,
            info.feed_end_date || null,
            new Date().toISOString()
        );
        return info;
    });

    const info = load();
    db.close();

    return {
        counts,
        feedVersion: info.feed_version,
        feedStart:   info.feed_start_date,
        feedEnd:     info.feed_end_date,
    };
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const zipPath = args.find(a => a.endsWith('.zip'));
    const dbPath  = args.find(a => a.endsWith('.sqlite'));
    importRaw({ zipPath, dbPath })
        .then(r => {
            console.log(`feed ${r.feedVersion}  (${r.feedStart} → ${r.feedEnd})`);
            for (const [t, n] of Object.entries(r.counts)) {
                console.log(`  ${t.padEnd(22)} ${n}`);
            }
            console.log('raw import ok');
        })
        .catch(err => {
            console.error(`raw import failed: ${err.message}`);
            process.exit(1);
        });
}

module.exports = { importRaw };
