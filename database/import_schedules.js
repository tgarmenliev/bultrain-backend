const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// --- Paths ---
const DB_PATH = path.join(__dirname, 'bultrain.sqlite');
const RAW_DIR = path.join(__dirname, 'raw_bdz_data');
const TRAIN_NUMBERS_PATH = path.join(__dirname, 'extracted', 'train_numbers.json');

// --- Station Name Normalization ---
function normalize(name) {
    let n = name.toLowerCase().trim();
    n = n.replace(/\s{2,}/g, ' ');
    // Standardize all variations of "stop" suffix → " - спирка"
    n = n.replace(/\s*-\s*сп\.\s*$/, ' - спирка');
    n = n.replace(/\s+сп\.\s*$/, ' - спирка');
    n = n.replace(/\s*-\s*спирка\s*$/, ' - спирка');
    return n;
}

// --- Train Type Abbreviation Map ---
const TYPE_TO_ABBR = {
    'пътнически влак': 'ПВ',
    'бърз влак': 'БВ',
    'крайградски пътнически влак': 'КПВ',
    'международен бърз влак': 'МБВ',
    'бърз влак със задължителна резервация': 'БВЗР',
    'експресен влак': 'ЕВ',
    'АВТ': 'АВТ',
};

function abbreviateType(fullType) {
    if (!fullType) return 'ПВ';
    const lower = fullType.toLowerCase().trim();
    return TYPE_TO_ABBR[lower] || fullType;
}

// --- Compare two station arrays for identity ---
function stationsAreIdentical(stationsA, stationsB) {
    if (!stationsA || !stationsB) return false;
    if (stationsA.length !== stationsB.length) return false;
    for (let i = 0; i < stationsA.length; i++) {
        const a = stationsA[i];
        const b = stationsB[i];
        if (
            normalize(a.station) !== normalize(b.station) ||
            a.arrive !== b.arrive ||
            a.depart !== b.depart
        ) {
            return false;
        }
    }
    return true;
}

// --- Main ---
const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

// Load station map: normalizedName → id
const allStations = db.prepare('SELECT id, name FROM stations').all();
const stationMap = new Map();
for (const s of allStations) {
    stationMap.set(normalize(s.name), s.id);
}
console.log(`Loaded ${stationMap.size} stations from DB`);

// Prepared statements
const insertTrain = db.prepare(`
  INSERT OR IGNORE INTO trains (train_number, category) VALUES (?, ?)
`);
const insertValidity = db.prepare(`
  INSERT INTO train_validity
    (train_number, runs_monday, runs_tuesday, runs_wednesday, runs_thursday, runs_friday, runs_saturday, runs_sunday, description, valid_from, valid_to)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
`);
const insertSchedule = db.prepare(`
  INSERT INTO schedules (validity_id, station_id, arrival_time, departure_time, stop_sequence)
  VALUES (?, ?, ?, ?, ?)
`);

// Transaction for a single train
const importTrain = db.transaction((trainNumber, category, validityRecords) => {
    insertTrain.run(trainNumber, category);

    for (const record of validityRecords) {
        const { days, description, stops } = record;
        const info = insertValidity.run(
            trainNumber,
            days.mon, days.tue, days.wed, days.thu, days.fri, days.sat, days.sun,
            description
        );
        const validityId = info.lastInsertRowid;

        for (let i = 0; i < stops.length; i++) {
            const stop = stops[i];
            insertSchedule.run(
                validityId,
                stop.stationId,
                stop.arrive,
                stop.depart,
                i + 1
            );
        }
    }
});

// --- Process trains ---
const trainNumbers = JSON.parse(fs.readFileSync(TRAIN_NUMBERS_PATH, 'utf-8'));
let successCount = 0;
let errorCount = 0;

for (const num of trainNumbers) {
    const trainNumber = String(num);

    try {
        const wedPath = path.join(RAW_DIR, `${trainNumber}_tue.json`);
        const satPath = path.join(RAW_DIR, `${trainNumber}_sat.json`);

        const wedExists = fs.existsSync(wedPath);
        const satExists = fs.existsSync(satPath);

        if (!wedExists && !satExists) {
            throw new Error('No data files found (neither wed nor sat)');
        }

        let wedData = null;
        let satData = null;

        if (wedExists) {
            wedData = JSON.parse(fs.readFileSync(wedPath, 'utf-8'));
            if (!wedData.stations || wedData.stations.length === 0) wedData = null;
        }
        if (satExists) {
            satData = JSON.parse(fs.readFileSync(satPath, 'utf-8'));
            if (!satData.stations || satData.stations.length === 0) satData = null;
        }

        if (!wedData && !satData) {
            throw new Error('Both files exist but have no station data');
        }

        // Determine category from whichever file is available
        const refData = wedData || satData;
        const category = abbreviateType(refData.trainType);

        // --- Resolve stations and check mapping ---
        function resolveStops(data) {
            const stops = [];
            for (const stop of data.stations) {
                const normalizedName = normalize(stop.station);
                const stationId = stationMap.get(normalizedName);

                if (stationId === undefined) {
                    throw new Error(`Unmapped station: ORIGINAL: "${stop.station}" | NORMALIZED: "${normalizedName}"`);
                }

                stops.push({
                    stationId,
                    arrive: stop.arrive === '↦' ? null : stop.arrive,
                    depart: stop.depart === '↤' ? null : stop.depart,
                });
            }
            return stops;
        }

        // Build validity records based on wed/sat comparison
        const validityRecords = [];

        if (wedData && satData) {
            const wedStops = resolveStops(wedData);
            const satStops = resolveStops(satData);

            if (stationsAreIdentical(wedData.stations, satData.stations)) {
                // Identical → single record for all 7 days
                validityRecords.push({
                    days: { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 1, sun: 1 },
                    description: 'Runs daily',
                    stops: wedStops,
                });
            } else {
                // Different → two records
                validityRecords.push({
                    days: { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 0, sun: 0 },
                    description: 'Weekday schedule',
                    stops: wedStops,
                });
                validityRecords.push({
                    days: { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 1, sun: 1 },
                    description: 'Weekend schedule',
                    stops: satStops,
                });
            }
        } else if (wedData) {
            const wedStops = resolveStops(wedData);
            validityRecords.push({
                days: { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 0, sun: 0 },
                description: 'Weekday only',
                stops: wedStops,
            });
        } else {
            const satStops = resolveStops(satData);
            validityRecords.push({
                days: { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 1, sun: 1 },
                description: 'Weekend only',
                stops: satStops,
            });
        }

        // --- Execute DB transaction ---
        importTrain(trainNumber, category, validityRecords);
        successCount++;
        console.log(`[SUCCESS] Imported train ${trainNumber} (${category}) — ${validityRecords.length} validity record(s)`);

    } catch (err) {
        errorCount++;
        console.log(`[ERROR] Train ${trainNumber}: ${err.message}`);
    }
}

db.close();

console.log(`\n${'='.repeat(50)}`);
console.log(`Import complete.`);
console.log(`  Success: ${successCount}`);
console.log(`  Errors:  ${errorCount}`);
console.log(`  Total:   ${trainNumbers.length}`);
