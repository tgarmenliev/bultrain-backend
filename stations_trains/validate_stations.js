const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'bultrain.sqlite');
const RAW_DIR = path.join(__dirname, 'raw_bdz_data');
const REPORT_PATH = path.join(__dirname, 'unmapped_stations_report.json');

// --- Normalization ---
function normalizeStationName(name) {
    let n = name.toLowerCase().trim();
    // Collapse multiple spaces
    n = n.replace(/\s{2,}/g, ' ');
    // Standardize "сп." abbreviation variants → "спирка"
    n = n.replace(/\s*-\s*сп\.\s*$/, ' - спирка');
    n = n.replace(/\s+сп\.\s*$/, ' - спирка');
    return n;
}

// --- Load DB station names into a Set ---
const db = new Database(DB_PATH, { readonly: true });
const dbStations = db.prepare('SELECT name FROM stations').all();
const knownNames = new Set(dbStations.map((row) => normalizeStationName(row.name)));
db.close();

console.log(`Loaded ${knownNames.size} normalized station names from DB`);

// --- Scan raw_bdz_data/ ---
const files = fs.readdirSync(RAW_DIR).filter((f) => f.endsWith('.json'));
const unmapped = {}; // originalName → [trainNumber, ...]

for (const file of files) {
    const filePath = path.join(RAW_DIR, file);
    let data;

    try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        continue; // skip malformed files
    }

    const trainNumber = data.trainNumber || file.replace(/_(wed|sat)\.json$/, '');
    const stations = data.stations || [];

    for (const stop of stations) {
        if (!stop.station) continue;

        const normalized = normalizeStationName(stop.station);

        if (!knownNames.has(normalized)) {
            const original = stop.station.trim();
            if (!unmapped[original]) {
                unmapped[original] = [];
            }
            if (!unmapped[original].includes(trainNumber)) {
                unmapped[original].push(trainNumber);
            }
        }
    }
}

// --- Output ---
fs.writeFileSync(REPORT_PATH, JSON.stringify(unmapped, null, 2), 'utf-8');

const count = Object.keys(unmapped).length;
console.log(`\nFound ${count} unique unmapped station names.`);
if (count > 0) {
    console.log(`Report saved to ${REPORT_PATH}`);
    console.log('\nUnmapped stations:');
    for (const [name, trains] of Object.entries(unmapped)) {
        console.log(`  "${name}" — found in trains: ${trains.join(', ')}`);
    }
}
