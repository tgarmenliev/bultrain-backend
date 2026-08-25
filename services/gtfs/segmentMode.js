'use strict';

/**
 * segmentMode.js — the train/bus category for a SPECIFIC boarding station of
 * a SPECIFIC trip on a SPECIFIC date, not "the" category of the train number.
 *
 * A number that partially runs as a replacement bus (see gtfs-bus-replacement
 * in memory) has separate trip rows under a rail category AND 'АВТ', chained
 * by time+station (004_date_based_serving.sql's own comment: "a single number
 * can be a train leg plus a replacement-bus leg"). trainCategory.displayFor()
 * picks whichever of those rows happens to load first for the number — no
 * ORDER BY, no awareness of which leg a given passenger is even on — so a
 * passenger travelling entirely on the TRAIN portion of such a number could
 * be shown "АВТ" (bus) simply because the bus-leg row won the race.
 *
 * Real incident (2026-08-23): train 30122, Копривщица→Волуяк by train,
 * Волуяк→Драгоман by replacement bus. A passenger travelling Антон→София —
 * entirely on the train portion — saw "АВТ 30122" on their push-to-start
 * card, and it flickered between that and "ПВ 30122" as different code paths
 * (armed_journeys vs live_activity_tokens, populated by different client
 * calls) hit the ambiguous lookup differently.
 */

const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.BULTRAIN_DB || path.join(__dirname, '..', '..', 'bultrain.sqlite');

let db = null;
function conn() {
    if (!db) db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    return db;
}

// Same tolerant matching contentState.js uses — station names drift in
// spelling ("Ловеч-север" vs "Ловеч - Север") between sources.
function normalize(s) {
    return String(s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[.\-–—]/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim();
}

const startMin = (s) => {
    const t = s.depart || s.arrive;
    if (!t) return Infinity;
    const [h, m] = String(t).split(':').map(Number);
    return h * 60 + m;
};

/** ISO date/Date → "YYYY-MM-DD" in the Sofia service-date sense trip_date uses. */
function sofiaServiceDate(isoOrDate) {
    const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-CA', { timeZone: 'Europe/Sofia' }); // en-CA => YYYY-MM-DD
}

/**
 * @returns {{category:string}|null} the leg category the passenger actually
 *          boards there, or null when it can't be resolved — the caller
 *          should then fall back to whatever it already had (client-supplied
 *          or the old whole-number lookup), not hard-fail.
 */
function resolveBoardingCategory(trainNumber, serviceDateYmd, boardingStationName) {
    if (!trainNumber || !serviceDateYmd || !boardingStationName) return null;
    try {
        const c = conn();
        const trips = c.prepare(`
            SELECT t.trip_id, t.category
            FROM trip t JOIN trip_date td ON td.trip_id = t.trip_id
            WHERE t.train_number = ? AND td.date = ?
        `).all(String(trainNumber), serviceDateYmd);
        if (!trips.length) return null;

        const stopStmt = c.prepare(`
            SELECT ts.arrive, ts.depart, st.name AS name
            FROM trip_stop ts JOIN stations st ON st.id = ts.station_id
            WHERE ts.trip_id = ? ORDER BY ts.seq
        `);
        const legs = trips
            .map(t => ({ category: t.category, stops: stopStmt.all(t.trip_id) }))
            .filter(l => l.stops.length > 0);
        if (!legs.length) return null;
        legs.sort((a, b) => startMin(a.stops[0]) - startMin(b.stops[0]));

        const target = normalize(boardingStationName);
        for (const leg of legs) {
            // Any stop except a leg's OWN last one is a place that leg departs
            // from. A transfer point is deliberately excluded here from the
            // EARLIER leg (it's that leg's last stop) but included as the
            // FIRST stop of the next leg — so it naturally resolves to the
            // onward leg's category, exactly matching the app's own transfer
            // semantics (buildStations in serving.js does the same thing).
            for (let i = 0; i < leg.stops.length - 1; i++) {
                if (normalize(leg.stops[i].name) === target) return { category: leg.category };
            }
        }
        return null; // boardingStation only ever matched a route's final stop
    } catch (err) {
        console.error('[segmentMode] resolution failed:', err.message);
        return null;
    }
}

module.exports = { resolveBoardingCategory, sofiaServiceDate };
