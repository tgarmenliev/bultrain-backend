'use strict';

/**
 * scripts/seed-stations.js fills a new database with the canonical station list. It may also be run
 * against a live one, so it only ADDS what is missing: a station's id is what saved alarms are keyed
 * to, and its coordinates may since have been corrected from the feed — a re-seed must not undo that.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'seed-stations.js');
const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-seed-')), 'test.sqlite');
const seed = () => execFileSync('node', [SCRIPT, TMP], { encoding: 'utf8' });
const stationsJson = require('../stations.json');

test('seeds every station of stations.json into a new database', () => {
    seed();
    const db = new Database(TMP, { readonly: true });
    const ids = new Set(db.prepare('SELECT id FROM stations').all().map(r => r.id));
    db.close();
    for (const s of stationsJson) assert.ok(ids.has(s.id), `station ${s.id} ${s.name}`);
});

test('running it again changes nothing', () => {
    assert.match(seed(), /\(\+0\)/);
});

test('a station that is already there is never touched — not its name, not its corrected coordinates', () => {
    const s = stationsJson[0];
    const db = new Database(TMP);
    db.prepare('UPDATE stations SET lat = ?, lon = ?, name = ? WHERE id = ?').run(1.5, 2.5, 'Преименувана', s.id);
    db.close();

    seed();

    const rd = new Database(TMP, { readonly: true });
    const row = rd.prepare('SELECT name, lat, lon FROM stations WHERE id = ?').get(s.id);
    rd.close();
    assert.deepStrictEqual(row, { name: 'Преименувана', lat: 1.5, lon: 2.5 });
});

test('a station removed from the database is added back', () => {
    const s = stationsJson[1];
    const db = new Database(TMP);
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM stations WHERE id = ?').run(s.id);
    db.close();

    assert.match(seed(), /\(\+1\)/);
});
