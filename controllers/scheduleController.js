const Database = require('better-sqlite3');
const path = require('path');

// ── Database ────────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, '..', 'bultrain.sqlite');
const db = new Database(DB_PATH, { readonly: true });
db.pragma('journal_mode = WAL');

// ── Category abbreviation maps ──────────────────────────────────────────────
const CATEGORY_EN = {
    'ПВ': 'PT',
    'КПВ': 'SUT',
    'БВ': 'FT',
    'МБВ': 'IFT',
    'БВЗР': 'FT',
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

/** Duration from absolute minute values (no wrap-around needed) */
function calcAbsoluteDuration(absDepartMins, absArriveMins) {
    const diff = absArriveMins - absDepartMins;
    const h = Math.floor(diff / 60);
    const m = diff % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
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

/** Add N days to a DD.MM.YYYY string and return a new DD.MM.YYYY string */
function addDaysToDateString(baseDateStr, daysToAdd) {
    const [dd, mm, yyyy] = baseDateStr.split('.').map(Number);
    const d = new Date(yyyy, mm - 1, dd);
    d.setDate(d.getDate() + daysToAdd);
    return formatDate(d);
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

// ── Core Schedule Logic ─────────────────────────────────────────────────────
exports.generateScheduleData = (language, from, to, date) => {
    if (language !== 'bg' && language !== 'en') {
        return { error: 'Bad request! Language does not exist!', status: 400 };
    }

    const fromStationId = parseInt(from);
    const toStationId = parseInt(to);
    if (isNaN(fromStationId) || isNaN(toStationId)) {
        return { error: 'Bad Request! Station numbers not correct!', status: 400 };
    }
    if (fromStationId === toStationId) {
        return { error: 'Bad Request! From and To stations are the same!', status: 400 };
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
        return { error: 'Bad Request! Wrong date!', status: 400 };
    }
    const dateObj = new Date(date + 'T00:00:00');
    if (isNaN(dateObj.getTime())) {
        return { error: 'Bad Request! Invalid date!', status: 400 };
    }

    const dayIndex = dateObj.getDay();
    const dayColumn = DAY_COLUMN[dayIndex];
    const dateStr = formatDate(dateObj);

    // ── Load data & find routes ─────────────────────────────────────
    const { trainRuns, stationDepartures } = loadDayData(dayColumn);
    const paths = findRoutes(trainRuns, stationDepartures, fromStationId, toStationId);

    const fromName = getStationName(fromStationId, language);
    const toName = getStationName(toStationId, language);

    if (paths.length === 0) {
        return {
            data: {
                date: dateStr,
                route: `${fromName} - ${toName}`,
                totalTrains: 0,
                options: [],
            }
        };
    }

    // ── Build option objects (with absolute time tracking) ────────
    let options = paths.map(legs => {
        const numOfTransfers = legs.length - 1;

        // Track absolute minutes from 00:00 of the request day
        let absTracker = 0;
        const trainObjs = [];

        for (let idx = 0; idx < legs.length; idx++) {
            const leg = legs[idx];
            const isLast = idx === legs.length - 1;
            const cat = (language === 'en')
                ? (CATEGORY_EN[leg.category] || leg.category)
                : leg.category;

            const legDepartRaw = timeToMin(leg.departTime);
            const legArriveRaw = timeToMin(leg.arriveTime);

            // Compute absolute depart
            let absDepart;
            if (idx === 0) {
                absDepart = legDepartRaw;
            } else {
                // Transfer: if depart time-of-day < previous absolute arrive time-of-day,
                // it means we crossed midnight during the wait
                const prevAbsArrive = trainObjs[idx - 1]._absArrive;
                absDepart = prevAbsArrive + waitMinutes(legs[idx - 1].arriveTime, leg.departTime);
            }

            // Compute absolute arrive
            let absArrive;
            if (legArriveRaw < legDepartRaw) {
                // Midnight crossing within this leg
                absArrive = absDepart + (legArriveRaw + 1440 - legDepartRaw);
            } else {
                absArrive = absDepart + (legArriveRaw - legDepartRaw);
            }

            // Compute dates: days offset from base date
            const departDayOffset = Math.floor(absDepart / 1440);
            const arriveDayOffset = Math.floor(absArrive / 1440);

            // Wait time to next train
            let timeToWaitNext = 0;
            if (!isLast) {
                // Will be filled after next leg is processed; placeholder
                timeToWaitNext = '__PENDING__';
            }

            trainObjs.push({
                from: getStationName(leg.fromStationId, language),
                to: getStationName(leg.toStationId, language),
                depart: leg.departTime,
                arrive: leg.arriveTime,
                departDate: addDaysToDateString(dateStr, departDayOffset),
                arriveDate: addDaysToDateString(dateStr, arriveDayOffset),
                trainType: cat,
                trainNumber: leg.trainNumber,
                duration: calcAbsoluteDuration(absDepart, absArrive),
                timeToWaitNext,
                // Internal fields (stripped later)
                _absDepart: absDepart,
                _absArrive: absArrive,
            });
        }

        // Fill in timeToWaitNext now that all legs have absolute times
        for (let i = 0; i < trainObjs.length - 1; i++) {
            const waitMins = trainObjs[i + 1]._absDepart - trainObjs[i]._absArrive;
            trainObjs[i].timeToWaitNext = minToTime(waitMins);
        }

        const overallAbsDepart = trainObjs[0]._absDepart;
        const overallAbsArrive = trainObjs[trainObjs.length - 1]._absArrive;

        // Strip internal fields from train objects
        const trains = trainObjs.map(({ _absDepart, _absArrive, ...rest }) => rest);

        return {
            duration: calcAbsoluteDuration(overallAbsDepart, overallAbsArrive),
            departureTime: legs[0].departTime,
            arrivalTime: legs[legs.length - 1].arriveTime,
            departureDate: trains[0].departDate,
            arrivalDate: trains[trains.length - 1].arriveDate,
            numOfTransfers,
            trains,
            // Internal fields for filtering/sorting
            departMins: overallAbsDepart,
            arriveMins: overallAbsArrive,
        };
    });

    // ── De-duplicate → Pareto filter → Sort ─────────────────────────
    options = dedup(options);
    options = paretoFilter(options);
    options.sort((a, b) => a.departMins - b.departMins);

    // Remove internal fields but KEEP departMins for scheduleSecController filtering, 
    // we'll strip it in the final HTTP handler or let the caller do it.
    // Actually, to not break existing clients, let's strip it before returning to API,
    // but the programmatic caller needs it. I'll return it and strip it in `getSchedule`.

    // For safety, let's keep departMins in the programmatic response.

    const resultData = {
        date: dateStr,
        route: `${fromName} - ${toName}`,
        totalTrains: options.length,
        options,
    };

    return { data: resultData };
};

// ── Controller ──────────────────────────────────────────────────────────────
exports.getSchedule = (req, res) => {
    const { language, from, to, date } = req.params;

    try {
        const result = exports.generateScheduleData(language, from, to, date);

        if (result.error) {
            return res.status(result.status).json({ error: result.error });
        }

        // Strip departMins and arriveMins before sending to client
        const finalOptions = result.data.options.map(({ departMins, arriveMins, ...rest }) => rest);

        const responseData = {
            ...result.data,
            totalTrains: finalOptions.length,
            options: finalOptions
        };

        res.header('Content-Type', 'application/json');
        res.send(JSON.stringify(responseData, null, 4));

    } catch (error) {
        console.error('scheduleController error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};
