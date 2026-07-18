'use strict';

/**
 * serving.js — read the date-based GTFS tables and produce responses in the
 * EXACT shape the legacy controllers return, so the mobile app sees no change.
 * The data underneath is GTFS (authoritative); the JSON envelope is identical.
 *
 * A train number can resolve to several trips on one date (a train leg plus a
 * replacement-bus leg). They are chained by time into one stop list, with the
 * shared transfer station merged, matching the old single flat "stations" array.
 */

const CATEGORY_BG = {
    'БВ': 'Бърз влак', 'ПВ': 'Пътнически влак', 'КПВ': 'Крайградски пътнически влак',
    'МБВ': 'Международен бърз влак', 'БВЗР': 'Бърз влак със задължителна резервация',
    'ЕВ': 'Експресен влак', 'АВТ': 'Автобус',
};
const CATEGORY_EN = {
    'БВ': 'Fast train', 'ПВ': 'Passenger train', 'КПВ': 'Suburban train',
    'МБВ': 'International fast train', 'БВЗР': 'Fast train with mandatory reservation',
    'ЕВ': 'Express train', 'АВТ': 'Bus',
};
const DAYS_BG = ['неделя', 'понеделник', 'вторник', 'сряда', 'четвъртък', 'петък', 'събота'];
const DAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatDate(dateObj, language) {
    const dd = String(dateObj.getDate()).padStart(2, '0');
    const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
    const yyyy = dateObj.getFullYear();
    const dayName = language === 'bg' ? DAYS_BG[dateObj.getDay()] : DAYS_EN[dateObj.getDay()];
    return `${dd}.${mm}.${yyyy} (${dayName})`;
}

function isoDate(dateObj) {
    return `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;
}

/**
 * Legacy-identical train-info from the GTFS trip tables.
 * @returns {{result:object}|{error:string,status:number}}
 */
function buildTrainInfo(db, { language, trainNo, dateObj }) {
    const ymd = isoDate(dateObj);

    const anyTrip = db.prepare('SELECT 1 FROM trip WHERE train_number = ? LIMIT 1').get(trainNo);
    if (!anyTrip) return { error: 'Train not found!', status: 404 };

    const trips = db.prepare(`
        SELECT t.trip_id, t.category
        FROM trip t JOIN trip_date td ON td.trip_id = t.trip_id
        WHERE t.train_number = ? AND td.date = ?
    `).all(trainNo, ymd);

    if (trips.length === 0) {
        const dayIndex = dateObj.getDay();
        const dayName = language === 'bg' ? DAYS_BG[dayIndex] : DAYS_EN[dayIndex];
        return {
            error: language === 'bg' ? `Влакът не се движи в ${dayName}!` : `Train does not run on ${dayName}!`,
            status: 404,
        };
    }

    const stopStmt = db.prepare(`
        SELECT ts.seq, ts.arrive, ts.depart, st.name AS bg_name, st.english_name
        FROM trip_stop ts JOIN stations st ON st.id = ts.station_id
        WHERE ts.trip_id = ? ORDER BY ts.seq
    `);

    // Build each leg, then order legs by their first departure time.
    const legs = trips.map(t => ({ category: t.category, stops: stopStmt.all(t.trip_id) }))
        .filter(l => l.stops.length > 0);
    const startMin = s => {
        const t = s.depart || s.arrive; if (!t) return 1e9;
        const [h, m] = t.split(':').map(Number); return h * 60 + m;
    };
    legs.sort((a, b) => startMin(a.stops[0]) - startMin(b.stops[0]));

    const nameOf = row => (language === 'en' ? (row.english_name || row.bg_name) : row.bg_name);

    // Chain legs into one stop list, merging the shared transfer station.
    const merged = [];
    for (const leg of legs) {
        for (const s of leg.stops) {
            const prev = merged[merged.length - 1];
            if (prev && prev._name === nameOf(s)) {
                prev.depart = s.depart || prev.depart;  // transfer point: keep arrival, take onward departure
                continue;
            }
            merged.push({ _name: nameOf(s), station: nameOf(s), arrive: s.arrive, depart: s.depart });
        }
    }

    // Endpoints use the same ↦ / ↤ markers as the legacy output.
    merged[0].arrive = '↦';
    merged[merged.length - 1].depart = '↤';
    const stations = merged.map(({ _name, ...rest }) => rest);

    const categoryMap = language === 'bg' ? CATEGORY_BG : CATEGORY_EN;
    const trainType = categoryMap[legs[0].category] || legs[0].category;

    return {
        result: {
            trainType,
            trainNumber: trainNo,
            date: formatDate(dateObj, language),
            stations,
        },
    };
}

module.exports = { buildTrainInfo };
