-- 001_baseline_schema.sql
--
-- The schema as it stood in production before GTFS work began. Every statement
-- is IF NOT EXISTS, so applying this against the live database is a no-op that
-- simply records the baseline, while a fresh clone gets the full schema built
-- from nothing. This replaces the old init_db.js + ad-hoc migrate.js.

CREATE TABLE IF NOT EXISTS stations (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    english_name TEXT,
    lat          REAL,
    lon          REAL
);

CREATE TABLE IF NOT EXISTS trains (
    train_number TEXT PRIMARY KEY,
    category     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS train_validity (
    validity_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    train_number   TEXT NOT NULL REFERENCES trains(train_number) ON DELETE CASCADE,
    runs_monday    INTEGER NOT NULL DEFAULT 0,
    runs_tuesday   INTEGER NOT NULL DEFAULT 0,
    runs_wednesday INTEGER NOT NULL DEFAULT 0,
    runs_thursday  INTEGER NOT NULL DEFAULT 0,
    runs_friday    INTEGER NOT NULL DEFAULT 0,
    runs_saturday  INTEGER NOT NULL DEFAULT 0,
    runs_sunday    INTEGER NOT NULL DEFAULT 0,
    description    TEXT,
    valid_from     TEXT,   -- NULL = permanent; ISO date = temporary window
    valid_to       TEXT
);

CREATE TABLE IF NOT EXISTS schedules (
    schedule_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    validity_id    INTEGER NOT NULL REFERENCES train_validity(validity_id) ON DELETE CASCADE,
    station_id     INTEGER NOT NULL REFERENCES stations(id),
    arrival_time   TEXT,
    departure_time TEXT,
    stop_sequence  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule_exceptions (
    exception_date         TEXT PRIMARY KEY,  -- ISO-8601
    schedule_type_override TEXT NOT NULL      -- e.g. 'sunday', 'saturday'
);

CREATE TABLE IF NOT EXISTS handbook_topics (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    app_topic_id INTEGER NOT NULL,
    language     TEXT    NOT NULL,
    title        TEXT    NOT NULL,
    subtitle     TEXT,
    cover_image  TEXT,
    sort_order   INTEGER
);

CREATE TABLE IF NOT EXISTS handbook_content (
    block_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_pk       INTEGER NOT NULL REFERENCES handbook_topics(id) ON DELETE CASCADE,
    sequence_order INTEGER NOT NULL,
    text_body      TEXT    NOT NULL,
    image          TEXT
);

CREATE INDEX IF NOT EXISTS idx_schedules_station_id  ON schedules(station_id);
CREATE INDEX IF NOT EXISTS idx_schedules_validity_id ON schedules(validity_id);
CREATE INDEX IF NOT EXISTS idx_train_validity_dates  ON train_validity(train_number, valid_from, valid_to);
