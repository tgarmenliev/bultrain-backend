const Database = require('better-sqlite3');
const path = require('path');
const { buildTrainInfo } = require('../services/gtfs/serving');

// ── Database ────────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, '..', 'bultrain.sqlite');
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// Serve from the GTFS date-based tables when SCHEDULE_SOURCE=gtfs; otherwise
// the legacy day-of-week path below. The JSON shape is identical either way.
const USE_GTFS = process.env.SCHEDULE_SOURCE === 'gtfs';

// ── Category translation maps ───────────────────────────────────────────────
const CATEGORY_BG = {
    'БВ': 'Бърз влак',
    'ПВ': 'Пътнически влак',
    'КПВ': 'Крайградски пътнически влак',
    'МБВ': 'Международен бърз влак',
    'БВЗР': 'Бърз влак със задължителна резервация',
    'ЕВ': 'Експресен влак',
    "АВТ": 'Автобус'
};

const CATEGORY_EN = {
    'БВ': 'Fast train',
    'ПВ': 'Passenger train',
    'КПВ': 'Suburban train',
    'МБВ': 'International fast train',
    'БВЗР': 'Fast train with mandatory reservation',
    'ЕВ': 'Express train',
    "АВТ": 'Bus'
};

// ── Day-of-week helpers ─────────────────────────────────────────────────────
// JS getDay(): 0 = Sunday … 6 = Saturday
const DAY_COLUMN = [
    'runs_sunday',    // 0
    'runs_monday',    // 1
    'runs_tuesday',   // 2
    'runs_wednesday', // 3
    'runs_thursday',  // 4
    'runs_friday',    // 5
    'runs_saturday',  // 6
];

const DAYS_BG = [
    'неделя', 'понеделник', 'вторник', 'сряда',
    'четвъртък', 'петък', 'събота',
];

const DAYS_EN = [
    'Sunday', 'Monday', 'Tuesday', 'Wednesday',
    'Thursday', 'Friday', 'Saturday',
];

// ── Prepared statements ─────────────────────────────────────────────────────
const stmtTrain = db.prepare(
    'SELECT category FROM trains WHERE train_number = ?'
);

// We build the validity query dynamically because the column name changes
// per day-of-week, but only from our own safe array — no injection risk.
function getValidityStmt(dayColumn) {
    return db.prepare(
        `SELECT validity_id FROM train_validity
         WHERE train_number = ? AND ${dayColumn} = 1
         LIMIT 1`
    );
}

const stmtSchedule = db.prepare(`
    SELECT s.arrival_time,
           s.departure_time,
           st.name        AS bg_name,
           st.english_name
    FROM   schedules s
    JOIN   stations  st ON st.id = s.station_id
    WHERE  s.validity_id = ?
    ORDER  BY s.stop_sequence ASC
`);

// ── Date formatting helper ──────────────────────────────────────────────────
function formatDate(dateObj, language) {
    const dd = String(dateObj.getDate()).padStart(2, '0');
    const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
    const yyyy = dateObj.getFullYear();
    const dow = dateObj.getDay(); // 0-6

    const dayName = language === 'bg' ? DAYS_BG[dow] : DAYS_EN[dow];
    return `${dd}.${mm}.${yyyy} (${dayName})`;
}

// ── Controller ──────────────────────────────────────────────────────────────
/**
 * GET /api/train-info/:language/:trainNo/:date?
 */
exports.getTrainInfo = (req, res) => {
    const { language, trainNo, date } = req.params;

    // ── Validate language ───────────────────────────────────────────────
    if (language !== 'bg' && language !== 'en') {
        return res.status(404).json({ error: 'Bad request! Invalid language!' });
    }

    // ── Validate train number length ────────────────────────────────────
    if (trainNo.length < 3 || trainNo.length > 6) {
        return res.status(404).json({ error: 'Bad request! Invalid train number!' });
    }

    try {
        // ── Resolve date ────────────────────────────────────────────────
        let dateObj;
        if (date) {
            dateObj = new Date(date + 'T00:00:00'); // local midnight
            if (isNaN(dateObj.getTime())) {
                return res.status(400).json({ error: 'Bad request! Invalid date format! Use YYYY-MM-DD.' });
            }
        } else {
            dateObj = new Date();
        }

        // ── GTFS date-based path (behind flag; identical JSON shape) ─────
        if (USE_GTFS) {
            const r = buildTrainInfo(db, { language, trainNo, dateObj });
            if (r.error) return res.status(r.status).json({ error: r.error });
            res.header('Content-Type', 'application/json');
            return res.send(JSON.stringify(r.result, null, 4));
        }

        const dayIndex = dateObj.getDay();          // 0-6
        const dayColumn = DAY_COLUMN[dayIndex];       // e.g. "runs_monday"

        // ── Fetch train ─────────────────────────────────────────────────
        const train = stmtTrain.get(trainNo);
        if (!train) {
            return res.status(404).json({ error: 'Train not found!' });
        }

        // ── Translate category ──────────────────────────────────────────
        const categoryMap = language === 'bg' ? CATEGORY_BG : CATEGORY_EN;
        const trainType = categoryMap[train.category] || train.category;

        // ── Fetch validity for the requested day ────────────────────────
        const validity = getValidityStmt(dayColumn).get(trainNo);
        if (!validity) {
            const dayName = language === 'bg' ? DAYS_BG[dayIndex] : DAYS_EN[dayIndex];
            return res.status(404).json({
                error: language === 'bg'
                    ? `Влакът не се движи в ${dayName}!`
                    : `Train does not run on ${dayName}!`,
            });
        }

        // ── Fetch schedule stops ────────────────────────────────────────
        const rows = stmtSchedule.all(validity.validity_id);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'No schedule data found for this train!' });
        }

        // ── Build response ──────────────────────────────────────────────
        const stations = rows.map(row => {
            // Pick station name based on language
            let stationName;
            if (language === 'en') {
                stationName = row.english_name || row.bg_name; // fallback
            } else {
                stationName = row.bg_name;
            }

            return {
                station: stationName,
                arrive: row.arrival_time === null ? '↦' : row.arrival_time,
                depart: row.departure_time === null ? '↤' : row.departure_time,
            };
        });

        const result = {
            trainType,
            trainNumber: trainNo,
            date: formatDate(dateObj, language),
            stations,
        };

        res.header('Content-Type', 'application/json');
        res.send(JSON.stringify(result, null, 4));

    } catch (error) {
        console.error('trainInfoController error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};
