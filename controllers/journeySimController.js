'use strict';

/**
 * journeySimController.js — HTTP surface for testFeed.js, gated behind
 * ENABLE_JOURNEY_SIM=on (404 otherwise, same pattern as test-push). Exists
 * because the server is one long-lived pm2 process and a driver script is a
 * separate one — there is no other way for scripts/sim-journey.js to reach
 * the running server's in-memory testFeed state.
 *
 * Every handler refuses any trainNumber that isn't in the reserved TEST-
 * prefixed namespace (testFeed.set() enforces this too — belt and braces),
 * so this endpoint structurally cannot be used to corrupt live data for a
 * real train even if called with a wrong or malicious payload.
 */

const testFeed = require('../services/liveactivity/testFeed');

function guard(res) {
    if (process.env.ENABLE_JOURNEY_SIM !== 'on') {
        res.status(404).json({ error: 'Not found.' });
        return false;
    }
    return true;
}

const bad = (res, message) => res.status(400).json({ error: message });

/**
 * POST /api/live-activity/sim/train
 * body: { trainNumber: "TEST-...", stops: [{ station, arrivalInSec?, departureInSec?, delayMin? }], vehicle?: {lat,lon,bearing} }
 * Offsets are seconds from now, not absolute times — friendlier for a script
 * driving a live manual test step by step.
 */
exports.setTrain = (req, res) => {
    if (!guard(res)) return;
    const b = req.body || {};
    const trainNumber = String(b.trainNumber || '');
    if (!testFeed.isTestTrain(trainNumber)) {
        return bad(res, `trainNumber must start with "${testFeed.TEST_TRAIN_PREFIX}" — refusing anything that could be a real train number.`);
    }
    if (!Array.isArray(b.stops) || !b.stops.length) return bad(res, 'stops (non-empty array) is required.');

    const nowSec = Math.floor(Date.now() / 1000);
    const stops = b.stops.map(s => {
        const delaySec = Number.isFinite(s.delayMin) ? Math.round(s.delayMin * 60) : null;
        return {
            station: String(s.station || ''),
            arrivalTime: Number.isFinite(s.arrivalInSec) ? nowSec + s.arrivalInSec : null,
            departureTime: Number.isFinite(s.departureInSec) ? nowSec + s.departureInSec : null,
            arrivalDelay: delaySec,
            departureDelay: delaySec,
        };
    });

    const vehicle = b.vehicle && Number.isFinite(b.vehicle.lat) && Number.isFinite(b.vehicle.lon)
        ? { lat: b.vehicle.lat, lon: b.vehicle.lon, bearing: Number.isFinite(b.vehicle.bearing) ? b.vehicle.bearing : 0 }
        : null;

    testFeed.set(trainNumber, { trip: { stops }, vehicle });

    console.log(`[sim] set ${trainNumber}: ${stops.length} stop(s)${vehicle ? ' + position' : ''}`);
    res.json({ ok: true, trainNumber, stops, vehicle });
};

/** DELETE /api/live-activity/sim/train/:trainNumber */
exports.clearTrain = (req, res) => {
    if (!guard(res)) return;
    const trainNumber = String(req.params.trainNumber || '');
    testFeed.clear(trainNumber);
    console.log(`[sim] cleared ${trainNumber}`);
    res.json({ ok: true });
};

/** GET /api/live-activity/sim/train — which test numbers currently have data. */
exports.listTrains = (req, res) => {
    if (!guard(res)) return;
    res.json({ trains: testFeed.list() });
};
