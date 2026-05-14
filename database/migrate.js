'use strict';

/**
 * migrate.js
 *
 * Idempotent migration for the live bultrain.sqlite database.
 * Adds the new columns and table introduced for GTFS-style schedule overrides.
 * Safe to run multiple times — each step is guarded.
 *
 * Usage:  node database/migrate.js
 */

const Database = require('better-sqlite3');
const path     = require('path');

const DB_PATH = path.join(__dirname, '..', 'bultrain.sqlite');
const db      = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Helper: check whether a column already exists ─────────────────────────────
function columnExists(table, column) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all();
    return info.some(col => col.name === column);
}

// ── Helper: check whether a table already exists ──────────────────────────────
function tableExists(table) {
    return !!db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
    ).get(table);
}

// ── Helper: check whether an index already exists ─────────────────────────────
function indexExists(name) {
    return !!db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name=?`
    ).get(name);
}

let steps = 0;

// ── Step 1: valid_from on train_validity ──────────────────────────────────────
if (!columnExists('train_validity', 'valid_from')) {
    db.exec(`ALTER TABLE train_validity ADD COLUMN valid_from TEXT`);
    console.log('[+] train_validity.valid_from added (NULL = permanent schedule)');
    steps++;
} else {
    console.log('[=] train_validity.valid_from already exists — skipped');
}

// ── Step 2: valid_to on train_validity ────────────────────────────────────────
if (!columnExists('train_validity', 'valid_to')) {
    db.exec(`ALTER TABLE train_validity ADD COLUMN valid_to TEXT`);
    console.log('[+] train_validity.valid_to added (NULL = permanent schedule)');
    steps++;
} else {
    console.log('[=] train_validity.valid_to already exists — skipped');
}

// ── Step 3: schedule_exceptions table ────────────────────────────────────────
if (!tableExists('schedule_exceptions')) {
    db.exec(`
        CREATE TABLE schedule_exceptions (
            exception_date          TEXT PRIMARY KEY,  -- ISO-8601, e.g. '2026-05-06'
            schedule_type_override  TEXT NOT NULL       -- e.g. 'sunday', 'saturday'
        )
    `);
    console.log('[+] schedule_exceptions table created');
    steps++;
} else {
    console.log('[=] schedule_exceptions already exists — skipped');
}

// ── Step 4: covering index for the temporal range query ───────────────────────
if (!indexExists('idx_train_validity_dates')) {
    db.exec(`
        CREATE INDEX idx_train_validity_dates
        ON train_validity(train_number, valid_from, valid_to)
    `);
    console.log('[+] idx_train_validity_dates created');
    steps++;
} else {
    console.log('[=] idx_train_validity_dates already exists — skipped');
}

db.close();

console.log(`\nMigration complete. ${steps} change(s) applied.`);
