const Database = require('better-sqlite3');
const path = require('path');

// ── Database ────────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, '..', 'bultrain.sqlite');
const db = new Database(DB_PATH, { readonly: true });
db.pragma('journal_mode = WAL');

// ── Category abbreviation maps ──────────────────────────────────────────────
const CATEGORY_EN = {
    'ПВ': 'RT',
    'КПВ': 'SRT',
    'БВ': 'ICF',
    'МБВ': 'IICF',
    'БВЗР': 'ICFMR',
    'ЕВ': 'ET',
};

// ── Day-of-week column mapping (JS getDay 0=Sun…6=Sat) ──────────────────────
const DAY_COLUMN = [
    'runs_sunday', 'runs_monday', 'runs_tuesday', 'runs_wednesday',
    'runs_thursday', 'runs_friday', 'runs_saturday',
];

// ── Time helpers ────────────────────────────────────────────────────────────
function timeToMin(t) {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
}

function minToTime(mins) {
    const h = Math.floor(mins / 60) % 24;
    const m = mins % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function calcDuration(depart, arrive) {
    let diff = timeToMin(arrive) - timeToMin(depart);
    if (diff < 0) diff += 24 * 60;
    return minToTime(diff);
}

function waitMinutes(arriveTime, departTime) {
    let diff = timeToMin(departTime) - timeToMin(arriveTime);
    if (diff < 0) diff += 24 * 60;
    return diff;
}

function formatDate(dateObj) {
    const dd = String(dateObj.getDate()).padStart(2, '0');
    const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
    const yyyy = dateObj.getFullYear();
    return `${dd}.${mm}.${yyyy}`;
}

// ── Station name lookup ─────────────────────────────────────────────────────
const stationNameStmt = db.prepare('SELECT name, english_name FROM stations WHERE id = ?');
const stationNameCache = new Map();

function getStationName(stationId, language) {
    const key = `${stationId}_${language}`;
    if (stationNameCache.has(key)) return stationNameCache.get(key);
    const row = stationNameStmt.get(stationId);
    if (!row) return String(stationId);
    const name = (language === 'en') ? (row.english_name || row.name) : row.name;
    stationNameCache.set(key, name);
    return name;
}

// ── Build in-memory data structures for a given day ─────────────────────────
function loadDayData(dayColumn) {
    const rows = db.prepare(`
        SELECT tv.validity_id, t.train_number, t.category,
               s.station_id, s.arrival_time, s.departure_time, s.stop_sequence
        FROM train_validity tv
        JOIN trains t    ON t.train_number = tv.train_number
        JOIN schedules s ON s.validity_id  = tv.validity_id
        WHERE tv.${dayColumn} = 1
        ORDER BY tv.validity_id, s.stop_sequence ASC
    `).all();

    // Group into train runs: { trainNumber, category, stops[] }
    const trainRuns = new Map();
    for (const row of rows) {
        if (!trainRuns.has(row.validity_id)) {
            trainRuns.set(row.validity_id, {
                trainNumber: row.train_number,
                category: row.category,
                stops: [],
            });
        }
        trainRuns.get(row.validity_id).stops.push({
            stationId: row.station_id,
            arrive: row.arrival_time,
            depart: row.departure_time,
            seq: row.stop_sequence,
        });
    }

    // Index: stationId → list of { validityId, stopIndex } for stops that have a departure
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

// ── BFS route finder ────────────────────────────────────────────────────────
const MAX_LEGS = 4;
const MIN_TRANSFER = 5;
const MAX_TRANSFER = 120;
const MAX_RESULTS = 200; // safety cap

function findRoutes(trainRuns, stationDepartures, fromStationId, toStationId) {
    const results = [];

    // queue: { currentStation, legs, visited, lastArriveTime, lastFromStation }
    const queue = [{
        currentStation: fromStationId,
        legs: [],
        visited: new Set([fromStationId]),
        lastArriveTime: null,
        lastFromStation: null,
    }];

    while (queue.length > 0 && results.length < MAX_RESULTS) {
        const state = queue.shift();
        if (state.legs.length >= MAX_LEGS) continue;

        const departures = stationDepartures.get(state.currentStation);
        if (!departures) continue;

        for (const { validityId, stopIndex } of departures) {
            const run = trainRuns.get(validityId);
            const boardStop = run.stops[stopIndex];

            // Transfer window check (for legs after the first)
            if (state.lastArriveTime !== null) {
                const wait = waitMinutes(state.lastArriveTime, boardStop.depart);
                if (wait < MIN_TRANSFER || wait > MAX_TRANSFER) continue;
            }

            // Ride this train to each possible alighting stop
            for (let j = stopIndex + 1; j < run.stops.length; j++) {
                const alightStop = run.stops[j];
                if (!alightStop.arrive) continue; // can't alight here

                const alightStationId = alightStop.stationId;

                // Anti-loop: don't revisit stations (except destination check below)
                if (state.visited.has(alightStationId) && alightStationId !== toStationId) continue;

                // Anti-zig-zag: don't go back to the station we came from
                if (state.lastFromStation !== null && alightStationId === state.lastFromStation) continue;

                const leg = {
                    fromStationId: state.currentStation,
                    toStationId: alightStationId,
                    departTime: boardStop.depart,
                    arriveTime: alightStop.arrive,
                    trainNumber: run.trainNumber,
                    category: run.category,
                };

                const newLegs = [...state.legs, leg];

                // Reached destination?
                if (alightStationId === toStationId) {
                    results.push(newLegs);
                    if (results.length >= MAX_RESULTS) break;
                    continue; // don't explore further from destination
                }

                // Continue search if we can add more legs
                if (newLegs.length < MAX_LEGS) {
                    const newVisited = new Set(state.visited);
                    newVisited.add(alightStationId);
                    queue.push({
                        currentStation: alightStationId,
                        legs: newLegs,
                        visited: newVisited,
                        lastArriveTime: alightStop.arrive,
                        lastFromStation: state.currentStation,
                    });
                }
            }
            if (results.length >= MAX_RESULTS) break;
        }
    }

    return results;
}

// ── Pareto domination filter ────────────────────────────────────────────────
function paretoFilter(options) {
    const dominated = new Set();
    for (let i = 0; i < options.length; i++) {
        if (dominated.has(i)) continue;
        for (let j = 0; j < options.length; j++) {
            if (i === j || dominated.has(j)) continue;
            const a = options[i], b = options[j];
            if (
                b.departMins >= a.departMins &&
                b.arriveMins <= a.arriveMins &&
                b.numOfTransfers <= a.numOfTransfers &&
                (b.departMins > a.departMins || b.arriveMins < a.arriveMins || b.numOfTransfers < a.numOfTransfers)
            ) {
                dominated.add(i);
                break;
            }
        }
    }
    return options.filter((_, idx) => !dominated.has(idx));
}

// ── De-duplicate identical options ──────────────────────────────────────────
function dedup(options) {
    // Group by: train number sequence + overall depart/arrive times.
    // Among options using the same train sequence with the same overall timing,
    // keep the one with the longest minimum transfer wait (most comfortable).
    const groups = new Map();
    for (const opt of options) {
        const trainSeq = opt.trains.map(t => t.trainNumber).join('|');
        const key = `${trainSeq}::${opt.departureTime}-${opt.arrivalTime}`;

        if (!groups.has(key)) {
            groups.set(key, opt);
        } else {
            // Keep the one with better (longer) minimum transfer wait
            const existing = groups.get(key);
            const existingMinWait = minTransferWait(existing);
            const newMinWait = minTransferWait(opt);
            if (newMinWait > existingMinWait) {
                groups.set(key, opt);
            }
        }
    }
    return Array.from(groups.values());
}

/** Get the minimum transfer wait time (in minutes) for an option */
function minTransferWait(opt) {
    if (opt.trains.length <= 1) return Infinity;
    let minWait = Infinity;
    for (let i = 0; i < opt.trains.length - 1; i++) {
        const tw = opt.trains[i].timeToWaitNext;
        if (typeof tw === 'string') {
            minWait = Math.min(minWait, timeToMin(tw));
        }
    }
    return minWait;
}

// ── Controller ──────────────────────────────────────────────────────────────
exports.getSchedule = (req, res) => {
    const { language, from, to, date } = req.params;

    if (language !== 'bg' && language !== 'en') {
        return res.status(400).json({ error: 'Bad request! Language does not exist!' });
    }

    const fromStationId = parseInt(from);
    const toStationId = parseInt(to);
    if (isNaN(fromStationId) || isNaN(toStationId)) {
        return res.status(400).json({ error: 'Bad Request! Station numbers not correct!' });
    }
    if (fromStationId === toStationId) {
        return res.status(400).json({ error: 'Bad Request! From and To stations are the same!' });
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
        return res.status(400).json({ error: 'Bad Request! Wrong date!' });
    }
    const dateObj = new Date(date + 'T00:00:00');
    if (isNaN(dateObj.getTime())) {
        return res.status(400).json({ error: 'Bad Request! Invalid date!' });
    }

    try {
        const dayIndex = dateObj.getDay();
        const dayColumn = DAY_COLUMN[dayIndex];
        const dateStr = formatDate(dateObj);

        // ── Load data & find routes ─────────────────────────────────────
        const { trainRuns, stationDepartures } = loadDayData(dayColumn);
        const paths = findRoutes(trainRuns, stationDepartures, fromStationId, toStationId);

        const fromName = getStationName(fromStationId, language);
        const toName = getStationName(toStationId, language);

        if (paths.length === 0) {
            return res.json({
                date: dateStr,
                route: `${fromName} - ${toName}`,
                totalTrains: 0,
                options: [],
            });
        }

        // ── Build option objects ────────────────────────────────────────
        let options = paths.map(legs => {
            const firstDepart = legs[0].departTime;
            const lastArrive = legs[legs.length - 1].arriveTime;
            const numOfTransfers = legs.length - 1;

            const trains = legs.map((leg, idx) => {
                const isLast = idx === legs.length - 1;
                const cat = (language === 'en')
                    ? (CATEGORY_EN[leg.category] || leg.category)
                    : leg.category;

                let timeToWaitNext = 0;
                if (!isLast) {
                    const nextLeg = legs[idx + 1];
                    timeToWaitNext = minToTime(waitMinutes(leg.arriveTime, nextLeg.departTime));
                }

                return {
                    from: getStationName(leg.fromStationId, language),
                    to: getStationName(leg.toStationId, language),
                    depart: leg.departTime,
                    arrive: leg.arriveTime,
                    departDate: dateStr,
                    arriveDate: dateStr,
                    trainType: cat,
                    trainNumber: leg.trainNumber,
                    duration: calcDuration(leg.departTime, leg.arriveTime),
                    timeToWaitNext,
                };
            });

            return {
                duration: calcDuration(firstDepart, lastArrive),
                departureTime: firstDepart,
                arrivalTime: lastArrive,
                departureDate: dateStr,
                arrivalDate: dateStr,
                numOfTransfers,
                trains,
                departMins: timeToMin(firstDepart),
                arriveMins: timeToMin(lastArrive),
            };
        });

        // ── De-duplicate → Pareto filter → Sort ─────────────────────────
        options = dedup(options);
        options = paretoFilter(options);
        options.sort((a, b) => a.departMins - b.departMins);

        // Remove internal fields
        options = options.map(({ departMins, arriveMins, ...rest }) => rest);

        const result = {
            date: dateStr,
            route: `${fromName} - ${toName}`,
            totalTrains: options.length,
            options,
        };

        res.header('Content-Type', 'application/json');
        res.send(JSON.stringify(result, null, 4));

    } catch (error) {
        console.error('scheduleController error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};
