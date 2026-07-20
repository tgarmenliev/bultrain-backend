'use strict';

const cache = require('../services/realtime/cache');

// Unix epoch (seconds) → HH:MM in Europe/Sofia.
function hhmm(epochSec) {
    if (!epochSec) return null;
    return new Date(epochSec * 1000).toLocaleTimeString('en-GB', {
        timeZone: 'Europe/Sofia', hour: '2-digit', minute: '2-digit',
    });
}

const toMin = (sec) => (sec == null ? null : Math.round(sec / 60));

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

    const stops = named.map(s => ({
        station:           s.station,
        stationId:         s.stationId,
        predictedArrival:  hhmm(s.arrivalTime),
        arrivalDelayMin:   toMin(s.arrivalDelay),
        departureDelayMin: toMin(s.departureDelay),
    }));

    // A single headline number: the delay at the next stop that carries one.
    const next = named.find(s => s.arrivalDelay != null || s.departureDelay != null);
    const delayMinutes = next ? toMin(next.arrivalDelay ?? next.departureDelay) : null;

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
