'use strict';

/**
 * migrate.js — versioned, forward-only migration runner.
 *
 * Applies every *.sql file in database/migrations/ that has not been applied
 * yet, in filename order, each inside its own transaction, and records it in
 * the schema_version table. Safe to run repeatedly: already-applied migrations
 * are skipped.
 *
 * Migrations must be idempotent-friendly (CREATE TABLE IF NOT EXISTS etc.) so
 * that baseline migration 001 is a harmless no-op against the existing
 * production database while still building the schema from nothing on a fresh
 * clone.
 *
 * Usage:  node database/migrate.js [path/to/db.sqlite]
 */

const Database = require('better-sqlite3');
const fs       = require('fs');
const path     = require('path');

const DB_PATH        = process.argv[2] || path.join(__dirname, '..', 'bultrain.sqlite');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function run(dbPath = DB_PATH) {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
            version     TEXT PRIMARY KEY,   -- the migration filename
            applied_at  TEXT NOT NULL       -- ISO-8601 UTC
        )
    `);

    const applied = new Set(
        db.prepare('SELECT version FROM schema_version').all().map(r => r.version)
    );

    const files = fs.readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith('.sql'))
        .sort(); // 001_, 002_, … lexicographic == numeric here

    const record = db.prepare(
        'INSERT INTO schema_version (version, applied_at) VALUES (?, ?)'
    );

    let count = 0;
    for (const file of files) {
        if (applied.has(file)) {
            console.log(`[=] ${file} already applied`);
            continue;
        }
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

        // Each migration is atomic: either the whole file applies and is
        // recorded, or nothing changes.
        const apply = db.transaction(() => {
            db.exec(sql);
            record.run(file, new Date().toISOString());
        });

        try {
            apply();
            console.log(`[+] ${file} applied`);
            count++;
        } catch (err) {
            db.close();
            throw new Error(`Migration ${file} failed: ${err.message}`);
        }
    }

    db.close();
    console.log(`\nMigrations up to date. ${count} applied this run.`);
    return count;
}

if (require.main === module) {
    try {
        run();
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}

module.exports = run;
