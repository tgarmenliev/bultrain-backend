'use strict';

/**
 * adminGtfsController.js — admin-panel endpoints backed by the saved GTFS
 * schedule (not the legacy scraped tables). Thin: all the querying lives in
 * services/gtfs/adminView.js; this only validates input and adds the two live
 * sources the dashboard shows (realtime cache health, tracking counters).
 */

const view       = require('../services/gtfs/adminView');
const cache      = require('../services/realtime/cache');
const armedStore = require('../services/liveactivity/armedStore');

const BAD_DATE = 'date must be a real calendar date in YYYY-MM-DD format.';

/** The requested date, the default when none was given, or null when invalid. */
function resolveDate(raw, range) {
    if (raw === undefined || raw === '') return view.defaultDate(range);
    return view.isValidYmd(raw) ? raw : null;
}

/**
 * GET /api/admin/overview
 * Dashboard numbers. A failing live source (cache, tracking) degrades to null
 * for that block only — the schedule numbers must not disappear with it.
 */
exports.overview = (req, res) => {
    try {
        const base = view.overview();

        let realtime = null;
        try {
            const s = cache.status();
            realtime = {
                trips: s.trips, vehicles: s.vehicles,
                tripFresh: s.tripFresh, vehicleFresh: s.vehicleFresh,
                tripFeedTs: s.tripFeedTs, vehicleFeedTs: s.vehicleFeedTs,
            };
        } catch (err) {
            console.warn('[admin] overview: realtime status unavailable:', err.message);
        }

        let tracking = null;
        try {
            const c = armedStore.counts();
            tracking = {
                armed: c.armed, started: c.started, devices: c.devices,
                devicesIos: c.devices_ios, devicesAndroid: c.devices_android,
            };
        } catch (err) {
            console.warn('[admin] overview: tracking counters unavailable:', err.message);
        }

        res.json({ ...base, realtime, tracking });
    } catch (err) {
        console.error('[admin] overview failed:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * GET /api/admin/gtfs/trains?date=YYYY-MM-DD
 * Trains running on that service date. No date = today (or the nearest covered
 * day when the schedule does not include today).
 */
exports.listTrains = (req, res) => {
    try {
        const range = view.dateRange();
        const date = resolveDate(req.query.date, range);
        if (date === null) return res.status(400).json({ error: BAD_DATE });

        res.json({ date, range, hasData: range !== null, trains: view.listTrainsOn(date) });
    } catch (err) {
        console.error('[admin] gtfs listTrains failed:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * GET /api/admin/gtfs/trains/:trainNo?date=YYYY-MM-DD
 */
exports.getTrain = (req, res) => {
    try {
        const trainNo = String(req.params.trainNo || '').trim();
        if (!trainNo || trainNo.length > 16) return res.status(400).json({ error: 'Invalid train number.' });

        const range = view.dateRange();
        const date = resolveDate(req.query.date, range);
        if (date === null) return res.status(400).json({ error: BAD_DATE });

        const train = view.getTrainOn(trainNo, date);
        if (!train) return res.status(404).json({ error: 'This train does not run on that date.' });
        res.json(train);
    } catch (err) {
        console.error('[admin] gtfs getTrain failed:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
};
