'use strict';

/**
 * routeWorker.js — BFS pathfinder, runs inside a Node.js worker_threads Worker.
 *
 * Receives via workerData:
 *   { fromStationId, toStationId, dayColumn, targetDate, dbPath, stationsJsonPath }
 *
 * Posts back via parentPort.postMessage():
 *   { success: true,  paths: [...] }
 *   { success: false, error: 'ROUTE_TOO_COMPLEX', partialPaths: [...] }
 */

const { workerData, parentPort } = require('worker_threads');
const Database = require('better-sqlite3');
const fs = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────
const MAX_TRANSFERS    = 4;          // max 4 transfers = 5 legs total
const MAX_LEGS         = MAX_TRANSFERS + 1;
const MIN_TRANSFER     = 5;          // minutes minimum transfer window
const MAX_TRANSFER     = 120;        // minutes maximum transfer window
const MAX_RESULTS      = 200;        // safety cap on number of route results
const TIMEOUT_MS       = 7000;       // 7 s hard execution cap inside worker
const GEO_PRUNE_FACTOR = 1.5;        // prune if next station is >1.5× further from dest

// ── Destructure workerData ────────────────────────────────────────────────────
const { fromStationId, toStationId, dayColumn, targetDate, dbPath, stationsJsonPath, useGtfs } = workerData;

// ── Haversine distance (km) ───────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1 * Math.PI / 180)
            * Math.cos(lat2 * Math.PI / 180)
            * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Load station coordinates from stations.json ───────────────────────────────
function loadStationCoords(jsonPath) {
    const coords = new Map(); // id → { lat, lon }
    try {
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        for (const s of data) {
            if (s.lat != null && s.lon != null) {
                coords.set(s.id, { lat: s.lat, lon: s.lon });
            }
        }
    } catch (_) {
        // If file can't be read, geo pruning is simply skipped
    }
    return coords;
}

// ── Time helpers ──────────────────────────────────────────────────────────────
function timeToMin(t) {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
}

function waitMinutes(arriveTime, departTime) {
    let diff = timeToMin(departTime) - timeToMin(arriveTime);
    if (diff < 0) diff += 24 * 60;
    return diff;
}

// ── Load train data for a date from the GTFS date-based tables ───────────────
// Produces the same { trainRuns, stationDepartures } shape the BFS consumes, so
// findRoutes is unchanged. Each GTFS trip is a run (keyed by trip_id in the
// `validityId` slot); a train leg and its replacement-bus leg are separate runs,
// so the planner naturally chains them as a transfer with per-leg category.
function loadDayDataGtfs(db, targetDate) {
    const rows = db.prepare(`
        SELECT t.trip_id, t.train_number, t.category,
               ts.station_id, ts.arrive, ts.depart, ts.seq
        FROM   trip       t
        JOIN   trip_date  td ON td.trip_id = t.trip_id AND td.date = ?
        JOIN   trip_stop  ts ON ts.trip_id = t.trip_id
        ORDER  BY t.trip_id, ts.seq
    `).all(targetDate);

    const trainRuns = new Map();
    for (const row of rows) {
        if (!trainRuns.has(row.trip_id)) {
            trainRuns.set(row.trip_id, { trainNumber: row.train_number, category: row.category, stops: [] });
        }
        trainRuns.get(row.trip_id).stops.push({
            stationId: row.station_id, arrive: row.arrive, depart: row.depart, seq: row.seq,
        });
    }

    const stationDepartures = new Map();
    for (const [tripId, run] of trainRuns) {
        for (let i = 0; i < run.stops.length; i++) {
            if (!run.stops[i].depart || run.stops[i].stationId == null) continue;
            const sid = run.stops[i].stationId;
            if (!stationDepartures.has(sid)) stationDepartures.set(sid, []);
            stationDepartures.get(sid).push({ validityId: tripId, stopIndex: i });
        }
    }
    return { trainRuns, stationDepartures };
}

// ── Load train data for the given day (Steps B & C priority) ─────────────────
function loadDayData(db, dayColumn, targetDate) {
    /*
     * Priority logic (mirrors GTFS calendar_dates + calendar approach):
     *   Step B – a validity row with valid_from <= targetDate <= valid_to wins.
     *   Step C – if no temporary row exists, fall back to the general row
     *            (valid_from IS NULL AND valid_to IS NULL).
     *
     * The CASE assigns rank 1 to temporary rows and rank 2 to general rows.
     * MIN(priority) inside the `best` CTE retains only the winning row per
     * train_number before the final join fetches its stop times.
     */
    const rows = db.prepare(`
        WITH ranked AS (
            SELECT
                tv.validity_id,
                tv.train_number,
                CASE
                    WHEN tv.valid_from IS NOT NULL
                     AND tv.valid_to   IS NOT NULL
                     AND tv.valid_from <= ?         -- targetDate
                     AND tv.valid_to   >= ?         -- targetDate
                    THEN 1   -- Step B: temporary schedule in range
                    WHEN tv.valid_from IS NULL
                     AND tv.valid_to   IS NULL
                    THEN 2   -- Step C: general (permanent) schedule
                    ELSE NULL
                END AS priority
            FROM train_validity tv
            WHERE tv.${dayColumn} = 1
        ),
        best AS (
            -- Keep only the highest-priority (lowest rank) row per train
            SELECT train_number, MIN(priority) AS best_priority
            FROM   ranked
            WHERE  priority IS NOT NULL
            GROUP  BY train_number
        )
        SELECT
            r.validity_id,
            t.train_number,
            t.category,
            s.station_id,
            s.arrival_time,
            s.departure_time,
            s.stop_sequence
        FROM   ranked        r
        JOIN   best          b  ON b.train_number  = r.train_number
                                AND b.best_priority = r.priority
        JOIN   trains        t  ON t.train_number  = r.train_number
        JOIN   schedules     s  ON s.validity_id   = r.validity_id
        ORDER  BY r.validity_id, s.stop_sequence ASC
    `).all(targetDate, targetDate);

    // Group into train runs: validityId → { trainNumber, category, stops[] }
    const trainRuns = new Map();
    for (const row of rows) {
        if (!trainRuns.has(row.validity_id)) {
            trainRuns.set(row.validity_id, {
                trainNumber: row.train_number,
                category:    row.category,
                stops:       [],
            });
        }
        trainRuns.get(row.validity_id).stops.push({
            stationId: row.station_id,
            arrive:    row.arrival_time,
            depart:    row.departure_time,
            seq:       row.stop_sequence,
        });
    }

    // Index: stationId → [{ validityId, stopIndex }] for stops that have a departure
    const stationDepartures = new Map();
    for (const [vid, run] of trainRuns) {
        for (let i = 0; i < run.stops.length; i++) {
            if (!run.stops[i].depart) continue;
            const sid = run.stops[i].stationId;
            if (!stationDepartures.has(sid)) stationDepartures.set(sid, []);
            stationDepartures.get(sid).push({ validityId: vid, stopIndex: i });
        }
    }

    return { trainRuns, stationDepartures };
}

// ── BFS route finder ──────────────────────────────────────────────────────────
function findRoutes(trainRuns, stationDepartures, fromStationId, toStationId, stationCoords) {
    const results    = [];
    const startTime  = Date.now();
    let   timedOut   = false;

    // Pre-compute destination coordinates for geographic pruning
    const destCoord = stationCoords.get(toStationId);

    // BFS queue state:
    //   currentStation  – station we are currently "at"
    //   legs            – array of leg objects already accumulated
    //   visited         – Set of stationIds visited in this path branch
    //   lastArriveTime  – arrival time string at currentStation (null for origin)
    //   lastFromStation – the station before currentStation (anti-zig-zag)
    const queue = [{
        currentStation: fromStationId,
        legs:           [],
        visited:        new Set([fromStationId]),
        lastArriveTime: null,
        lastFromStation: null,
    }];

    while (queue.length > 0 && results.length < MAX_RESULTS) {
        // ── Execution timeout check ────────────────────────────────────────────
        if (Date.now() - startTime > TIMEOUT_MS) {
            timedOut = true;
            break;
        }

        const state = queue.shift();

        // ── Depth limit: prune if we've already used all legs ────────────────
        if (state.legs.length >= MAX_LEGS) continue;

        const departures = stationDepartures.get(state.currentStation);
        if (!departures) continue;

        // Current station coord for geo heuristic
        const curCoord = stationCoords.get(state.currentStation);
        const curDistToDest = (curCoord && destCoord)
            ? haversine(curCoord.lat, curCoord.lon, destCoord.lat, destCoord.lon)
            : null;

        for (const { validityId, stopIndex } of departures) {
            // ── Execution timeout check (inner loop) ──────────────────────────
            if (Date.now() - startTime > TIMEOUT_MS) {
                timedOut = true;
                break;
            }

            const run       = trainRuns.get(validityId);
            const boardStop = run.stops[stopIndex];

            // Transfer window check (only for legs after the first)
            if (state.lastArriveTime !== null) {
                const wait = waitMinutes(state.lastArriveTime, boardStop.depart);
                if (wait < MIN_TRANSFER || wait > MAX_TRANSFER) continue;
            }

            // Ride this train to each possible alighting stop
            for (let j = stopIndex + 1; j < run.stops.length; j++) {
                // ── Execution timeout check (innermost loop) ──────────────────
                if (Date.now() - startTime > TIMEOUT_MS) {
                    timedOut = true;
                    break;
                }

                const alightStop      = run.stops[j];
                if (!alightStop.arrive) continue;  // can't alight here

                const alightStationId = alightStop.stationId;

                // ── Cycle prevention: never revisit a station ─────────────────
                // (Destination is the sole exception — it terminates the path)
                if (state.visited.has(alightStationId) && alightStationId !== toStationId) continue;

                // ── Anti-zig-zag: don't step back to the station we just left ─
                if (state.lastFromStation !== null && alightStationId === state.lastFromStation) continue;

                // ── Geographic heuristic: prune branches heading away from dest ─
                // Only apply when alight station ≠ destination and we have coords
                if (alightStationId !== toStationId && curDistToDest !== null) {
                    const alightCoord = stationCoords.get(alightStationId);
                    if (alightCoord) {
                        const alightDistToDest = haversine(
                            alightCoord.lat, alightCoord.lon,
                            destCoord.lat,   destCoord.lon,
                        );
                        // If moving to this station takes us more than GEO_PRUNE_FACTOR
                        // times farther from the destination, prune it.
                        if (alightDistToDest > curDistToDest * GEO_PRUNE_FACTOR) continue;
                    }
                }

                const leg = {
                    fromStationId:  state.currentStation,
                    toStationId:    alightStationId,
                    departTime:     boardStop.depart,
                    arriveTime:     alightStop.arrive,
                    trainNumber:    run.trainNumber,
                    category:       run.category,
                };

                const newLegs = [...state.legs, leg];

                // ── Reached destination? ──────────────────────────────────────
                if (alightStationId === toStationId) {
                    results.push(newLegs);
                    if (results.length >= MAX_RESULTS) break;
                    continue; // don't explore beyond destination
                }

                // ── Continue search if depth budget allows ────────────────────
                if (newLegs.length < MAX_LEGS) {
                    const newVisited = new Set(state.visited);
                    newVisited.add(alightStationId);
                    queue.push({
                        currentStation:  alightStationId,
                        legs:            newLegs,
                        visited:         newVisited,
                        lastArriveTime:  alightStop.arrive,
                        lastFromStation: state.currentStation,
                    });
                }
            }

            if (timedOut || results.length >= MAX_RESULTS) break;
        }

        if (timedOut) break;
    }

    return { paths: results, timedOut };
}

// ── Main execution ────────────────────────────────────────────────────────────
try {
    const db           = new Database(dbPath, { readonly: true, fileMustExist: true });

    const stationCoords = loadStationCoords(stationsJsonPath);
    const { trainRuns, stationDepartures } = useGtfs
        ? loadDayDataGtfs(db, targetDate)
        : loadDayData(db, dayColumn, targetDate);
    const { paths, timedOut } = findRoutes(
        trainRuns, stationDepartures,
        fromStationId, toStationId,
        stationCoords,
    );

    db.close();

    if (timedOut) {
        parentPort.postMessage({
            success:      false,
            error:        'ROUTE_TOO_COMPLEX',
            partialPaths: paths,  // return whatever was found before the timeout
        });
    } else {
        parentPort.postMessage({
            success: true,
            paths,
        });
    }
} catch (err) {
    parentPort.postMessage({
        success: false,
        error:   err.message,
        partialPaths: [],
    });
}
