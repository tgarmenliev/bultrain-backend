'use strict';

/**
 * The guide endpoints must return ONLY guide topics, never articles — the two
 * now share the handbook_topics table, so the guide queries filter
 * category='guide'. Without it a travel_idea article leaks into the guide list,
 * and (because articles set app_topic_id to their own PK) can even collide with
 * a guide topic on the single-topic endpoint.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const Database = require('better-sqlite3');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-guide-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

// Seed a guide topic and an article that shares the same app_topic_id (55).
const db = new Database(TMP);
db.prepare(`INSERT INTO handbook_topics (id, app_topic_id, language, title, category, status)
            VALUES (900, 55, 'bg', 'Как се чете табло', 'guide', 'published')`).run();
db.prepare(`INSERT INTO handbook_topics (id, app_topic_id, language, title, category, status)
            VALUES (55, 55, 'bg', 'Идея за пътуване', 'travel_idea', 'published')`).run();
db.close();

const topics = require('../controllers/guideTopicsController');
const guide  = require('../controllers/guideController');

function mockRes() {
    return {
        statusCode: 200, payload: null, headers: {},
        status(c) { this.statusCode = c; return this; },
        json(o) { this.payload = o; return this; },
        header() { return this; },
        send(s) { this.payload = typeof s === 'string' ? JSON.parse(s) : s; return this; },
    };
}

test('the guide list excludes articles', () => {
    const res = mockRes();
    topics.getAllTopics({ params: { language: 'bg' } }, res);
    assert.strictEqual(res.statusCode, 200);
    const titles = res.payload.map(t => t.title);
    assert.ok(titles.includes('Как се чете табло'), 'the guide topic is present');
    assert.ok(!titles.includes('Идея за пътуване'), 'the article must not leak into the guide list');
});

test('the single guide topic endpoint resolves the guide, not the article, on a shared id', () => {
    const res = mockRes();
    guide.getGuideTopic({ params: { language: 'bg', topic: '55' } }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.payload.title, 'Как се чете табло', 'category=guide filter wins the app_topic_id collision');
});
