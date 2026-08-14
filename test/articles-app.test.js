'use strict';

/**
 * Phase 5 — the app-facing articles view.
 *   - list and detail serve ONLY published articles;
 *   - a draft is 404 to the app, unless a valid preview token is supplied;
 *   - the detail envelope matches the guide's ({ title, image, content:[{text}] })
 *     with `type` per block and metadata on top.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

process.env.JWT_SECRET = 'test-secret';
const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-artapp-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const users    = require('../services/auth/users');
const admin    = { uid: users.create({ username: 'ana', password_hash: 'h', salt: 's', role: 'author' }), role: 'author' };
const articles = require('../controllers/articlesController');   // writable (admin side)
const app      = require('../controllers/appArticlesController'); // readonly (app side)

function mockRes() {
    return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } };
}
function create(title, blocks, language = 'bg') {
    const res = mockRes();
    articles.create({ admin, body: { title, language, region: 'Тест', duration_min: 300, blocks } }, res);
    return res.body.id;
}
function publish(id) { articles.publish({ params: { id: String(id) } }, mockRes()); }

// One published, one draft.
const publishedId = create('Публикувана идея', [
    { block_type: 'heading', text_body: 'Заглавие' },
    { block_type: 'image', image: 'art-x.jpg', text_body: 'Гарата' },
]);
publish(publishedId);
const draftId = create('Чернова идея', [{ block_type: 'paragraph', text_body: 'Още не е готова' }]);

test('list returns only published articles', () => {
    const res = mockRes();
    app.list({ query: {} }, res);
    assert.strictEqual(res.body.count, 1);
    assert.strictEqual(res.body.articles.length, 1);
    assert.strictEqual(res.body.articles[0].id, publishedId);
    assert.strictEqual(res.body.articles[0].durationMin, 300, 'metadata is camelCased for the app');
    assert.ok('image' in res.body.articles[0], 'cover image key is present (null here)');
});

test('list filters by language — a bg reader never sees en articles', () => {
    const enId = create('An English idea', [{ block_type: 'paragraph', text_body: 'x' }], 'en');
    publish(enId);

    // default (no lang) is bg → the en article is absent
    let res = mockRes();
    app.list({ query: {} }, res);
    assert.ok(res.body.articles.every((a) => a.id !== enId), 'en article hidden from the bg default');
    assert.ok(res.body.articles.some((a) => a.id === publishedId), 'bg article present');

    // ?lang=en → only the en one
    res = mockRes();
    app.list({ query: { lang: 'en' } }, res);
    assert.strictEqual(res.body.count, 1);
    assert.strictEqual(res.body.articles[0].id, enId);
});

test('detail of a published article uses the guide envelope with block types', () => {
    const res = mockRes();
    app.getOne({ params: { id: String(publishedId) }, query: {} }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.title, 'Публикувана идея');
    assert.deepStrictEqual(res.body.content.map(c => c.type), ['heading', 'image']);
    assert.strictEqual(res.body.content[0].text, 'Заглавие');
    assert.strictEqual(res.body.content[1].image, 'art-x.jpg');
    assert.ok(!('image' in res.body.content[0]), 'image key omitted when the block has none');
});

test('a draft is 404 to the app', () => {
    const res = mockRes();
    app.getOne({ params: { id: String(draftId) }, query: {} }, res);
    assert.strictEqual(res.statusCode, 404);
});

test('a draft opens with a valid preview token, and only its own', () => {
    // mint a token for the draft
    let res = mockRes();
    articles.previewToken({ params: { id: String(draftId) } }, res);
    const token = res.body.token;
    assert.ok(token);

    res = mockRes();
    app.getOne({ params: { id: String(draftId) }, query: { preview: token } }, res);
    assert.strictEqual(res.statusCode, 200, 'valid token unlocks the draft');
    assert.strictEqual(res.body.preview, true, 'flagged as a preview');

    // the same token must not unlock a different article
    res = mockRes();
    app.getOne({ params: { id: String(publishedId + 999) }, query: { preview: token } }, res);
    assert.strictEqual(res.statusCode, 404);

    // a garbage token does nothing
    res = mockRes();
    app.getOne({ params: { id: String(draftId) }, query: { preview: 'not-a-jwt' } }, res);
    assert.strictEqual(res.statusCode, 404);
});
