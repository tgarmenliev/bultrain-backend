'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const cache = require('../services/realtime/cache');

const DB_PATH = path.join(__dirname, '..', 'bultrain.sqlite');
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
const startedAt = Date.now();

const stmtStations = db.prepare('SELECT COUNT(*) AS c FROM stations');
const stmtToday    = db.prepare('SELECT COUNT(*) AS c FROM trip_date WHERE date = ?');

/**
 * GET /health  (public, for external uptime monitoring)
 *
 * 200 = the core is up (database reachable). The body also reports whether the
 * GTFS schedule covers today and whether realtime is fresh, so a monitor can
 * surface "degraded" without the process being down. 503 only when the DB
 * itself can't be read — a real outage.
 */
exports.getHealth = (req, res) => {
    try {
        const stations = stmtStations.get().c;

        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Sofia' });
        const tripsToday = stmtToday.get(today).c;

        const rt = cache.status();
        const realtimeOn = process.env.REALTIME === 'on';

        const gtfsOk = tripsToday > 0;
        const body = {
            status: gtfsOk ? 'ok' : 'degraded',
            uptimeSec: Math.round((Date.now() - startedAt) / 1000),
            db: { ok: true, stations },
            gtfs: { coversToday: gtfsOk, tripsToday },
            realtime: {
                enabled: realtimeOn,
                tripFresh: rt.tripFresh,
                vehicleFresh: rt.vehicleFresh,
                vehicles: rt.vehicles,
            },
        };
        res.status(200).json(body);
    } catch (err) {
        res.status(503).json({ status: 'error', db: { ok: false }, error: err.message });
    }
};
