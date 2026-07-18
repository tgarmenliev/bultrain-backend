'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const { Worker } = require('worker_threads');

// ── Paths ─────────────────────────────────────────────────────────────────────
const DB_PATH           = path.join(__dirname, '..', 'bultrain.sqlite');
const STATIONS_JSON     = path.join(__dirname, '..', 'stations.json');
const WORKER_PATH       = path.join(__dirname, '..', 'workers', 'routeWorker.js');

// ── Database (main thread – used only for station name lookups) ───────────────
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// Build the route graph from the GTFS date-based tables when SCHEDULE_SOURCE=gtfs.
const USE_GTFS = process.env.SCHEDULE_SOURCE === 'gtfs';

// ── Category abbreviation maps ────────────────────────────────────────────────
const CATEGORY_EN = {
    'ПВ':   'PT',
    'КПВ':  'SUT',
    'БВ':   'FT',
    'МБВ':  'IFT',
    'БВЗР': 'FT',
    'ЕВ':   'ET',
    "АВТ": 'BUS'
};

// ── Day-of-week column mapping (JS getDay 0=Sun…6=Sat) ───────────────────────
const DAY_COLUMN = [
    'runs_sunday', 'runs_monday', 'runs_tuesday', 'runs_wednesday',
    'runs_thursday', 'runs_friday', 'runs_saturday',
];

// ── Time helpers ──────────────────────────────────────────────────────────────
function timeToMin(t) {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
}

function minToTime(mins) {
    const h = Math.floor(mins / 60) % 24;
    const m = mins % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

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
    const dd   = String(dateObj.getDate()).padStart(2, '0');
    const mm   = String(dateObj.getMonth() + 1).padStart(2, '0');
    const yyyy = dateObj.getFullYear();
    return `${dd}.${mm}.${yyyy}`;
}

function addDaysToDateString(baseDateStr, daysToAdd) {
    const [dd, mm, yyyy] = baseDateStr.split('.').map(Number);
    const d = new Date(yyyy, mm - 1, dd);
    d.setDate(d.getDate() + daysToAdd);
    return formatDate(d);
}

// ── Station name lookup (main thread only) ────────────────────────────────────
const stationNameStmt  = db.prepare('SELECT name, english_name FROM stations WHERE id = ?');
const stationNameCache = new Map();

function getStationName(stationId, language) {
    const key = `${stationId}_${language}`;
    if (stationNameCache.has(key)) return stationNameCache.get(key);
    const row  = stationNameStmt.get(stationId);
    if (!row)  return String(stationId);
    const name = (language === 'en') ? (row.english_name || row.name) : row.name;
    stationNameCache.set(key, name);
    return name;
}

// ── Step A: resolve the effective day-of-week for schedule lookup ──────────────
// Checks schedule_exceptions first; if an entry exists for the date, that
// override type wins (e.g. a Wednesday national holiday → treat as 'sunday').
// Falls back to the real calendar day when no exception is found.
const exceptionStmt = db.prepare(
    'SELECT schedule_type_override FROM schedule_exceptions WHERE exception_date = ?'
);

function resolveEffectiveDayColumn(isoDate, calendarDayIndex) {
    const row = exceptionStmt.get(isoDate);
    if (row) {
        const col = `runs_${row.schedule_type_override.toLowerCase()}`;
        if (DAY_COLUMN.includes(col)) return col;  // validated against known columns
    }
    return DAY_COLUMN[calendarDayIndex]; // Step A fallback: real calendar weekday
}

// ── Spawn the BFS worker and await its result ─────────────────────────────────
/**
 * Runs the pathfinding algorithm in a Worker Thread so the main event loop
 * remains free to serve other HTTP requests.
 *
 * Resolves with the raw `paths` array.
 * Rejects on hard timeout (main-thread guard) or on worker error.
 *
 * @param {number} fromStationId
 * @param {number} toStationId
 * @param {string} dayColumn  e.g. 'runs_monday'
 * @returns {Promise<{ paths: Array, timedOut?: boolean, partialPaths?: Array }>}
 */
function runRouteWorker(fromStationId, toStationId, dayColumn, targetDate) {
    return new Promise((resolve, reject) => {
        const MAIN_THREAD_TIMEOUT_MS = 9000; // slightly longer than worker's own 7 s

        const worker = new Worker(WORKER_PATH, {
            workerData: {
                fromStationId,
                toStationId,
                dayColumn,
                targetDate,         // ISO-8601, used by worker for Steps B & C
                dbPath:           DB_PATH,
                stationsJsonPath: STATIONS_JSON,
                useGtfs:          USE_GTFS,
            },
        });

        // Hard timeout on the main thread (belt-and-suspenders)
        const timer = setTimeout(() => {
            worker.terminate();
            reject(new Error('WORKER_TIMED_OUT'));
        }, MAIN_THREAD_TIMEOUT_MS);

        worker.on('message', (result) => {
            clearTimeout(timer);
            resolve(result);
        });

        worker.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                clearTimeout(timer);
                reject(new Error(`Worker exited with code ${code}`));
            }
        });
    });
}

// ── Pareto domination filter ──────────────────────────────────────────────────
function paretoFilter(options) {
    const dominated = new Set();
    for (let i = 0; i < options.length; i++) {
        if (dominated.has(i)) continue;
        for (let j = 0; j < options.length; j++) {
            if (i === j || dominated.has(j)) continue;
            const a = options[i], b = options[j];
            if (
                b.departMins    >= a.departMins &&
                b.arriveMins    <= a.arriveMins &&
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

// ── De-duplicate identical options ───────────────────────────────────────────
function minTransferWait(opt) {
    if (opt.trains.length <= 1) return Infinity;
    let minWait = Infinity;
    for (let i = 0; i < opt.trains.length - 1; i++) {
        const tw = opt.trains[i].timeToWaitNext;
        if (typeof tw === 'string') minWait = Math.min(minWait, timeToMin(tw));
    }
    return minWait;
}

function dedup(options) {
    const groups = new Map();
    for (const opt of options) {
        const trainSeq = opt.trains.map(t => t.trainNumber).join('|');
        const key      = `${trainSeq}::${opt.departureTime}-${opt.arrivalTime}`;
        if (!groups.has(key)) {
            groups.set(key, opt);
        } else {
            const existing = groups.get(key);
            if (minTransferWait(opt) > minTransferWait(existing)) {
                groups.set(key, opt);
            }
        }
    }
    return Array.from(groups.values());
}

// ── Convert raw paths → formatted option objects ──────────────────────────────
function buildOptions(paths, dateStr, language) {
    return paths.map(legs => {
        const numOfTransfers = legs.length - 1;
        const trainObjs      = [];

        for (let idx = 0; idx < legs.length; idx++) {
            const leg   = legs[idx];
            const isLast = idx === legs.length - 1;
            const cat   = (language === 'en')
                ? (CATEGORY_EN[leg.category] || leg.category)
                : leg.category;

            const legDepartRaw = timeToMin(leg.departTime);
            const legArriveRaw = timeToMin(leg.arriveTime);

            let absDepart;
            if (idx === 0) {
                absDepart = legDepartRaw;
            } else {
                const prevAbsArrive = trainObjs[idx - 1]._absArrive;
                absDepart = prevAbsArrive + waitMinutes(legs[idx - 1].arriveTime, leg.departTime);
            }

            let absArrive;
            if (legArriveRaw < legDepartRaw) {
                absArrive = absDepart + (legArriveRaw + 1440 - legDepartRaw);
            } else {
                absArrive = absDepart + (legArriveRaw - legDepartRaw);
            }

            const departDayOffset = Math.floor(absDepart / 1440);
            const arriveDayOffset = Math.floor(absArrive / 1440);

            trainObjs.push({
                from:          getStationName(leg.fromStationId, language),
                to:            getStationName(leg.toStationId,   language),
                depart:        leg.departTime,
                arrive:        leg.arriveTime,
                departDate:    addDaysToDateString(dateStr, departDayOffset),
                arriveDate:    addDaysToDateString(dateStr, arriveDayOffset),
                trainType:     cat,
                trainNumber:   leg.trainNumber,
                duration:      calcAbsoluteDuration(absDepart, absArrive),
                timeToWaitNext: isLast ? 0 : '__PENDING__',
                _absDepart:    absDepart,
                _absArrive:    absArrive,
            });
        }

        // Fill in timeToWaitNext now that all legs have absolute times
        for (let i = 0; i < trainObjs.length - 1; i++) {
            const waitMins = trainObjs[i + 1]._absDepart - trainObjs[i]._absArrive;
            trainObjs[i].timeToWaitNext = minToTime(waitMins);
        }

        const overallAbsDepart = trainObjs[0]._absDepart;
        const overallAbsArrive = trainObjs[trainObjs.length - 1]._absArrive;

        const trains = trainObjs.map(({ _absDepart, _absArrive, ...rest }) => rest);

        return {
            duration:      calcAbsoluteDuration(overallAbsDepart, overallAbsArrive),
            departureTime: legs[0].departTime,
            arrivalTime:   legs[legs.length - 1].arriveTime,
            departureDate: trains[0].departDate,
            arrivalDate:   trains[trains.length - 1].arriveDate,
            numOfTransfers,
            trains,
            // Internal fields kept for downstream filtering (scheduleSecController)
            departMins: overallAbsDepart,
            arriveMins: overallAbsArrive,
        };
    });
}

// ── Core schedule logic (now async) ──────────────────────────────────────────
/**
 * @returns {Promise<{ data?: object, error?: string, status?: number }>}
 */
exports.generateScheduleData = async (language, from, to, date) => {
    if (language !== 'bg' && language !== 'en') {
        return { error: 'Bad request! Language does not exist!', status: 400 };
    }

    const fromStationId = parseInt(from);
    const toStationId   = parseInt(to);
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

    const dayIndex  = dateObj.getDay();
    const dayColumn = resolveEffectiveDayColumn(date, dayIndex); // Step A
    const dateStr   = formatDate(dateObj);

    const fromName = getStationName(fromStationId, language);
    const toName   = getStationName(toStationId,   language);

    // ── Offload BFS to worker thread (passes date for Steps B & C) ────────────
    let workerResult;
    try {
        workerResult = await runRouteWorker(fromStationId, toStationId, dayColumn, date);
    } catch (err) {
        console.error('routeWorker error:', err.message);
        return { error: 'Search timed out or failed. Please try again.', status: 503 };
    }

    // Worker returned a graceful timeout with partial results
    if (!workerResult.success && workerResult.error === 'ROUTE_TOO_COMPLEX') {
        console.warn(
            `[scheduleController] Route ${fromStationId}→${toStationId} timed out. ` +
            `Returning ${workerResult.partialPaths.length} partial results.`
        );
        // Fall through with partial paths so the user still gets something
    }

    const rawPaths = workerResult.success
        ? workerResult.paths
        : (workerResult.partialPaths || []);

    if (rawPaths.length === 0) {
        return {
            data: {
                date:        dateStr,
                route:       `${fromName} - ${toName}`,
                totalTrains: 0,
                options:     [],
                ...(workerResult.error === 'ROUTE_TOO_COMPLEX' && { warning: 'ROUTE_TOO_COMPLEX' }),
            },
        };
    }

    // ── Post-processing on main thread (fast, no BFS, no blocking) ────────────
    let options = buildOptions(rawPaths, dateStr, language);
    options = dedup(options);
    options = paretoFilter(options);
    options.sort((a, b) => a.departMins - b.departMins);

    return {
        data: {
            date:        dateStr,
            route:       `${fromName} - ${toName}`,
            totalTrains: options.length,
            options,
            ...(workerResult.error === 'ROUTE_TOO_COMPLEX' && { warning: 'ROUTE_TOO_COMPLEX' }),
        },
    };
};

// ── HTTP handler ──────────────────────────────────────────────────────────────
exports.getSchedule = async (req, res) => {
    const { language, from, to, date } = req.params;

    try {
        const result = await exports.generateScheduleData(language, from, to, date);

        if (result.error) {
            return res.status(result.status).json({ error: result.error });
        }

        // Strip internal tracking fields before sending to client
        const finalOptions = result.data.options.map(({ departMins, arriveMins, ...rest }) => rest);

        const responseData = {
            ...result.data,
            totalTrains: finalOptions.length,
            options:     finalOptions,
        };

        res.header('Content-Type', 'application/json');
        res.send(JSON.stringify(responseData, null, 4));

    } catch (error) {
        console.error('scheduleController error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};
