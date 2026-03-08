const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'bultrain.sqlite');
const STATIONS_PATH = path.join(__dirname, 'stations.json');

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

// --- Safely add missing columns ---
const newColumns = [
    'ALTER TABLE stations ADD COLUMN english_name TEXT',
    'ALTER TABLE stations ADD COLUMN lat REAL',
    'ALTER TABLE stations ADD COLUMN lon REAL',
];

for (const sql of newColumns) {
    try {
        db.exec(sql);
    } catch (err) {
        // Column already exists — ignore
    }
}

// --- Read stations.json ---
const stations = JSON.parse(fs.readFileSync(STATIONS_PATH, 'utf-8'));

// --- Seed inside a single transaction ---
const insert = db.prepare(`
  INSERT OR REPLACE INTO stations (id, name, english_name, lat, lon)
  VALUES (?, ?, ?, ?, ?)
`);

const insertAll = db.transaction((rows) => {
    for (const s of rows) {
        insert.run(s.id, s.name, s.englishName, s.lat, s.lon);
    }
});

insertAll(stations);

db.close();

console.log(`Seeded ${stations.length} stations into bultrain.sqlite`);
