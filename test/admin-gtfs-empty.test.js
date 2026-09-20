'use strict';

/**
 * Before the first GTFS import the saved-schedule tables are empty. The admin
 * must say so honestly (hasData:false) and the dashboard must not show a
 * misleading zero — it falls back to the legacy train count until GTFS exists.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-adminview-empty-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const Database = require('better-sqlite3');
{
    const db = new Database(TMP);
    db.prepare("INSERT INTO trains (train_number, category) VALUES ('111', 'ПВ'), ('222', 'БВ')").run();
    db.close();
}

const view = require('../services/gtfs/adminView');
const ctrl = require('../controllers/adminGtfsController');
const mockRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } });

test('an empty GTFS import is reported as such, not as a broken screen', () => {
    assert.strictEqual(view.dateRange(), null);

    const res = mockRes();
    ctrl.listTrains({ query: {} }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.hasData, false);
    assert.strictEqual(res.body.range, null);
    assert.deepStrictEqual(res.body.trains, []);
});

test('overview falls back to the legacy count only while GTFS is empty', () => {
    const o = view.overview();
    assert.strictEqual(o.gtfs.hasData, false);
    assert.strictEqual(o.trains, 2, 'legacy table stands in until GTFS is imported');
    assert.strictEqual(o.gtfs.daysLeft, null, 'no schedule, no "days left" claim');
    assert.strictEqual(o.gtfs.importedAt, null);
    assert.strictEqual(o.delays, null, 'no observations, no figure');
});
