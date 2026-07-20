'use strict';

const cache = require('../services/realtime/cache');

// Unix epoch (seconds) → HH:MM in Europe/Sofia.
function hhmm(epochSec) {
    if (!epochSec) return null;
    return new Date(epochSec * 1000).toLocaleTimeString('en-GB', {
        timeZone: 'Europe/Sofia', hour: '2-digit', minute: '2-digit',
    });
}

// Guard only against a hypothetical multi-day feed glitch. Real delays can be
// huge — international transit trains (Optima Express etc.) genuinely run 700+
// min late — and showing that accurately is a feature, not a bug.
const MAX_ABS_DELAY_SEC = 20 * 3600;
const toMin = (sec) =>
    (sec == null || Math.abs(sec) > MAX_ABS_DELAY_SEC) ? null : Math.round(sec / 60);

/**
 * GET /api/realtime/train/:trainNo
 * Live delay + predicted arrival per stop for a running train.
 * 404 when the train has no live data (not running, or feed stale) — the app
 * then falls back to the static schedule.
 */
exports.getTrain = (req, res) => {
    const num = req.params.trainNo;
    const rt = cache.getTrain(num);
    if (!rt) return res.status(404).json({ error: 'No live data for this train.' });

    // Keep only stops that map to one of our passenger stations. The ~2% that
    // don't are technical points (junctions/yards) absent from the static feed,
    // and would just show as an unnamed stop to the user.
    const named = rt.stops.filter(s => s.stationId != null);

    // The feed carries the WHOLE trip — stops the train has already passed
    // (with their actual times) and the ones still ahead. Flag which is which
    // so the app can show just the upcoming ones or the full progress.
    const nowSec = Date.now() / 1000;
    const stops = named.map(s => ({
        station:           s.station,
        stationId:         s.stationId,
        predictedArrival:  hhmm(s.arrivalTime),
        arrivalDelayMin:   toMin(s.arrivalDelay),
        departureDelayMin: toMin(s.departureDelay),
        passed:            s.arrivalTime ? (s.arrivalTime < nowSec) : null,
    }));

    // Headline = the CURRENT delay: the delay at the next stop still ahead,
    // falling back to the last stop if the train is finishing.
    const upcoming = named.filter(s => s.arrivalTime && s.arrivalTime >= nowSec);
    const ref = upcoming[0] || named[named.length - 1];
    const delayMinutes = ref ? toMin(ref.arrivalDelay ?? ref.departureDelay) : null;

    res.json({ trainNumber: num, delayMinutes, stops });
};

/**
 * GET /api/realtime/vehicle/:trainNo
 * Live GPS position + bearing of a running train.
 */
exports.getVehicle = (req, res) => {
    const num = req.params.trainNo;
    const v = cache.getVehicle(num);
    if (!v) return res.status(404).json({ error: 'No live position for this train.' });
    res.json({ trainNumber: num, lat: v.lat, lon: v.lon, bearing: v.bearing });
};

/**
 * GET /api/realtime/vehicles
 * Every running train's position — for the map / "radar".
 */
exports.getVehicles = (req, res) => {
    const vehicles = cache.getAllVehicles().map(([num, v]) => ({
        trainNumber: num, lat: v.lat, lon: v.lon, bearing: v.bearing,
    }));
    res.json({ count: vehicles.length, vehicles });
};

/**
 * GET /api/realtime/status  — poller/cache health (debugging).
 */
exports.getStatus = (req, res) => res.json(cache.status());
