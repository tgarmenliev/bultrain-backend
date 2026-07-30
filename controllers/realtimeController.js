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
 * Live status for a running train, merged from the two realtime feeds.
 *
 * NAP publishes TripUpdates (delay + per-stop times) and VehiclePositions (GPS)
 * as SEPARATE feeds with different coverage — there are consistently more trains
 * with a position than with a TripUpdate. So a train can be visibly running (we
 * have its position) yet have no delay data. We report it as running with
 * `delayMinutes: null` rather than 404, so the app shows "on the move, delay
 * unknown" instead of falling all the way back to the static timetable.
 *
 * 404 only when the train is in NEITHER feed (not running, or both stale).
 *
 * Response is additive over the old shape: `trainNumber`, `delayMinutes`,
 * `stops` are unchanged; `hasLiveDelay` and `position` are new.
 */
exports.getTrain = (req, res) => {
    const num = req.params.trainNo;
    const rt = cache.getTrain(num);
    const v  = cache.getVehicle(num);

    if (!rt && !v) return res.status(404).json({ error: 'No live data for this train.' });

    let stops = [];
    let delayMinutes = null;
    if (rt) {
        // Keep only stops that map to one of our passenger stations. The ~2% that
        // don't are technical points (junctions/yards) absent from the static feed,
        // and would just show as an unnamed stop to the user.
        const named = rt.stops.filter(s => s.stationId != null);

        // The feed carries the WHOLE trip — stops the train has already passed
        // (with their actual times) and the ones still ahead. Flag which is which
        // so the app can show just the upcoming ones or the full progress.
        const nowSec = Date.now() / 1000;
        stops = named.map(s => ({
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
        delayMinutes = ref ? toMin(ref.arrivalDelay ?? ref.departureDelay) : null;
    }

    const position = v ? { lat: v.lat, lon: v.lon, bearing: v.bearing } : null;

    res.json({
        trainNumber:  num,
        delayMinutes,              // null when only a position is available
        hasLiveDelay: !!rt,        // false ⇒ running on position alone
        stops,                     // [] when there's no TripUpdate
        position,                  // null when there's no VehiclePosition
    });
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
