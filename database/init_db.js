const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'bultrain.sqlite');

console.log(`Initializing database at ${DB_PATH}...`);

const db = new Database(DB_PATH);

// --- Pragmas ---
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Schema ---
db.exec(`
  CREATE TABLE IF NOT EXISTS stations (
    id    INTEGER PRIMARY KEY,
    name  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS trains (
    train_number  TEXT PRIMARY KEY,
    category      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS train_validity (
    validity_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    train_number  TEXT NOT NULL REFERENCES trains(train_number) ON DELETE CASCADE,
    runs_monday   INTEGER NOT NULL DEFAULT 0,
    runs_tuesday  INTEGER NOT NULL DEFAULT 0,
    runs_wednesday INTEGER NOT NULL DEFAULT 0,
    runs_thursday INTEGER NOT NULL DEFAULT 0,
    runs_friday   INTEGER NOT NULL DEFAULT 0,
    runs_saturday INTEGER NOT NULL DEFAULT 0,
    runs_sunday   INTEGER NOT NULL DEFAULT 0,
    description   TEXT
  );

  CREATE TABLE IF NOT EXISTS schedules (
    schedule_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    validity_id    INTEGER NOT NULL REFERENCES train_validity(validity_id) ON DELETE CASCADE,
    station_id     INTEGER NOT NULL REFERENCES stations(id),
    arrival_time   TEXT,
    departure_time TEXT,
    stop_sequence  INTEGER NOT NULL
  );
`);

// --- Performance Indexes ---
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_schedules_station_id  ON schedules(station_id);
  CREATE INDEX IF NOT EXISTS idx_schedules_validity_id ON schedules(validity_id);
`);

db.close();

console.log('Database initialized successfully.');
console.log('Tables: stations, trains, train_validity, schedules');
console.log('Indexes: idx_schedules_station_id, idx_schedules_validity_id');
