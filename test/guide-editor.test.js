'use strict';

/**
 * The guide moving into the shared block editor (articlesController), reusing
 * the same tables/handlers travel_idea articles already use, distinguished by
 * category. Three things matter here specifically:
 *
 *   - an 'author' role must be refused for anything guide-category — the guide
 *     is official app content, not a personal article;
 *   - editing an EXISTING guide topic must never touch app_topic_id or
 *     sort_order — the app's /api/guide/:lang and /api/guide/:lang/:topic key
 *     off both, and either changing would break live deep links / ordering;
 *   - a brand-new guide topic must not jump to the top of the app's guide list
 *     (NULL sort_order sorts first in SQLite ASC).
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const Database = require('better-sqlite3');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-guideed-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const articles = require('../controllers/articlesController');
const users    = require('../services/auth/users');

// author_id is a real FK into users — fake uids would fail the insert.
const adminUid  = users.create({ username: 'boss', password_hash: 'h', salt: 's', role: 'admin' });
const authorUid = users.create({ username: 'ana',  password_hash: 'h', salt: 's', role: 'author' });
const admin  = { role: 'admin',  uid: adminUid,  username: 'boss' };
const author = { role: 'author', uid: authorUid, username: 'ana' };

function mockRes() {
    return {
        statusCode: 200, body: null,
        status(c) { this.statusCode = c; return this; },
        json(o) { this.body = o; return this; },
        header() { return this; },                          // guideTopicsController's style
        send(s) { this.body = typeof s === 'string' ? JSON.parse(s) : s; return this; },
    };
}

// Seed one EXISTING guide topic the way the real one was created: migration
// 009's backfill (category='guide', a legacy app_topic_id, a real sort_order).
const db = new Database(TMP);
db.prepare(`
    INSERT INTO handbook_topics
        (id, app_topic_id, language, title, subtitle, category, status, sort_order, cover_image)
    VALUES (500, 7, 'bg', 'Как се чете табло', 'Обяснение', 'guide', 'published', 3, 'topic7.jpg')
`).run();
db.prepare(`INSERT INTO handbook_content (topic_pk, sequence_order, block_type, text_body) VALUES (500, 1, 'paragraph', 'Текст.')`).run();
db.close();

// ── Role gating ──────────────────────────────────────────────────────────────

test('an author is refused on every guide-category operation', () => {
    let res = mockRes();
    articles.list({ query: { category: 'guide' }, admin: author }, res);
    assert.strictEqual(res.statusCode, 403);

    res = mockRes();
    articles.getOne({ params: { id: '500' }, admin: author }, res);
    assert.strictEqual(res.statusCode, 403, 'even a guessed guide id is refused, not just the list');

    res = mockRes();
    articles.create({ admin: author, body: { title: 'X', language: 'bg', category: 'guide', blocks: [] } }, res);
    assert.strictEqual(res.statusCode, 403);

    res = mockRes();
    articles.update({ params: { id: '500' }, admin: author, body: { title: 'Hacked', language: 'bg' } }, res);
    assert.strictEqual(res.statusCode, 403);

    res = mockRes();
    articles.remove({ params: { id: '500' }, admin: author }, res);
    assert.strictEqual(res.statusCode, 403);
});

test('an admin can list and read guide content; travel_idea stays open to authors', () => {
    let res = mockRes();
    articles.list({ query: { category: 'guide' }, admin }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.some(t => t.id === 500));

    res = mockRes();
    articles.list({ query: {}, admin: author }, res); // default category = travel_idea
    assert.strictEqual(res.statusCode, 200, 'authors are unaffected for their own category');
});

// ── Existing guide topic: editing must not disturb what the app keys on ─────

test('editing an existing guide topic preserves app_topic_id and sort_order', () => {
    const res = mockRes();
    articles.update({ params: { id: '500' }, admin, body: {
        title: 'Как се чете табло (обновено)', language: 'bg', blocks: [
            { block_type: 'paragraph', text_body: 'Нов текст.' },
        ],
    } }, res);
    assert.strictEqual(res.statusCode, 200);

    const row = new Database(TMP, { readonly: true }).prepare('SELECT * FROM handbook_topics WHERE id = 500').get();
    assert.strictEqual(row.app_topic_id, 7, 'the app deep-links on this — must survive an edit untouched');
    assert.strictEqual(row.sort_order, 3, 'the app-facing list order must survive an edit untouched');
    assert.strictEqual(row.title, 'Как се чете табло (обновено)', 'the actual edit did apply');
    assert.strictEqual(row.category, 'guide', 'category itself is never reassigned by update');
});

test('the guide list endpoint the app uses is unaffected by any of this', () => {
    // Simulates GET /api/guide/bg — proves the real-world read path still works.
    const guideTopicsController = require('../controllers/guideTopicsController');
    const res = mockRes();
    guideTopicsController.getAllTopics({ params: { language: 'bg' } }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(Array.isArray(res.body) && res.body.some(t => t.id === 7), 'app_topic_id 7 still resolves after the edit above');
});

// ── New guide topics ──────────────────────────────────────────────────────────

test('a NEW guide topic gets a sort_order that appends, not jumps to the top', () => {
    const res = mockRes();
    articles.create({ admin, body: {
        title: 'Нова тема', language: 'bg', category: 'guide',
        blocks: [{ block_type: 'paragraph', text_body: 'Ново.' }],
    } }, res);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.category, 'guide');

    const row = new Database(TMP, { readonly: true }).prepare('SELECT sort_order FROM handbook_topics WHERE id = ?').get(res.body.id);
    assert.ok(row.sort_order > 3, 'must sort after the existing topic (sort_order=3), never NULL (which sorts first)');
});

test('a new travel_idea article is unaffected — sort_order stays irrelevant (NULL)', () => {
    const res = mockRes();
    articles.create({ admin, body: { title: 'Идея', language: 'bg', blocks: [] } }, res); // no category = travel_idea
    const row = new Database(TMP, { readonly: true }).prepare('SELECT sort_order, category FROM handbook_topics WHERE id = ?').get(res.body.id);
    assert.strictEqual(row.category, 'travel_idea');
    assert.strictEqual(row.sort_order, null, 'travel_idea is ordered by date, not sort_order');
});

// ── Category cannot be spoofed on update/delete ──────────────────────────────

test('a client cannot smuggle a travel_idea past the guide guard via update body', () => {
    // An author's own article — attempting to relabel it as guide in the body
    // must be ignored; the guard checks the ROW's real category, not the claim.
    const created = mockRes();
    articles.create({ admin: author, body: { title: 'Моя идея', language: 'bg', blocks: [] } }, created);
    const id = created.body.id;

    const res = mockRes();
    articles.update({ params: { id: String(id) }, admin: author, body: {
        title: 'Опит', language: 'bg', category: 'guide',
    } }, res);
    assert.strictEqual(res.statusCode, 200, 'still just her own travel_idea article — the claim is ignored, not honoured');

    const row = new Database(TMP, { readonly: true }).prepare('SELECT category FROM handbook_topics WHERE id = ?').get(id);
    assert.strictEqual(row.category, 'travel_idea', 'category can never be reassigned via update, by design');
});
