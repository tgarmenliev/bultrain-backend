'use strict';

/**
 * Phase 4a — the article CRUD controller.
 *   - block validation rules (pure);
 *   - a full lifecycle against a temp DB via the handlers: create draft → read →
 *     update (replace blocks) → publish → unpublish → delete.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-artcrud-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const articles = require('../controllers/articlesController');
const users    = require('../services/auth/users');

// A real author must exist — author_id is a foreign key into users.
const AUTHOR_UID = users.create({ username: 'ana', password_hash: 'h', salt: 's', role: 'author' });

// ── block validation ─────────────────────────────────────────────────────────

test('validateBlocks accepts the six block types and normalises sequence', () => {
    const v = articles.validateBlocks([
        { block_type: 'heading', text_body: 'Заглавие' },
        { block_type: 'paragraph', text_body: 'Текст' },
        { block_type: 'image', image: 'art-1.jpg', text_body: '' },
        { block_type: 'route', text_body: '' },
    ]);
    assert.strictEqual(v.ok, true);
    assert.deepStrictEqual(v.blocks.map(b => b.seq), [1, 2, 3, 4]);
    assert.strictEqual(v.blocks[2].image, 'art-1.jpg');
});

test('validateBlocks rejects unknown types, empty required text, imageless image', () => {
    assert.strictEqual(articles.validateBlocks([{ block_type: 'video' }]).ok, false);
    assert.strictEqual(articles.validateBlocks([{ block_type: 'paragraph', text_body: '  ' }]).ok, false);
    assert.strictEqual(articles.validateBlocks([{ block_type: 'image' }]).ok, false);
    assert.strictEqual(articles.validateBlocks('nope').ok, false);
});

// ── lifecycle ────────────────────────────────────────────────────────────────

function mockRes() {
    return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } };
}
const admin = { uid: AUTHOR_UID, role: 'author', username: 'ana' };

test('article lifecycle: create → read → update → publish → unpublish → delete', () => {
    // create
    let res = mockRes();
    articles.create({ admin, body: {
        title: 'Еднодневно до Копривщица', language: 'bg', region: 'Средногорие',
        duration_min: 600, related_train: '10112', featured: true,
        blocks: [
            { block_type: 'heading', text_body: 'Защо' },
            { block_type: 'paragraph', text_body: 'Тръгва се сутрин' },
        ],
    } }, res);
    assert.strictEqual(res.statusCode, 201);
    const id = res.body.id;
    assert.ok(id > 0);

    // read — draft, blocks present, metadata kept
    res = mockRes();
    articles.getOne({ params: { id: String(id) } }, res);
    assert.strictEqual(res.body.status, 'draft', 'new articles are drafts');
    assert.strictEqual(res.body.category, 'travel_idea');
    assert.strictEqual(res.body.related_train, '10112');
    assert.strictEqual(res.body.featured, 1);
    assert.strictEqual(res.body.blocks.length, 2);

    // update — replace blocks and change a field
    res = mockRes();
    articles.update({ params: { id: String(id) }, body: {
        title: 'Еднодневно до Копривщица', language: 'bg',
        blocks: [{ block_type: 'paragraph', text_body: 'Само един блок сега' }],
    } }, res);
    assert.strictEqual(res.statusCode, 200);
    res = mockRes();
    articles.getOne({ params: { id: String(id) } }, res);
    assert.strictEqual(res.body.blocks.length, 1, 'blocks are replaced wholesale');

    // publish
    res = mockRes();
    articles.publish({ params: { id: String(id) } }, res);
    res = mockRes();
    articles.getOne({ params: { id: String(id) } }, res);
    assert.strictEqual(res.body.status, 'published');
    assert.ok(res.body.published_at, 'published_at is stamped');

    // unpublish keeps the original published_at but hides it
    res = mockRes();
    articles.unpublish({ params: { id: String(id) } }, res);
    res = mockRes();
    articles.getOne({ params: { id: String(id) } }, res);
    assert.strictEqual(res.body.status, 'draft');

    // delete (blocks cascade)
    res = mockRes();
    articles.remove({ params: { id: String(id) } }, res);
    assert.strictEqual(res.body.message, 'Article deleted.');
    res = mockRes();
    articles.getOne({ params: { id: String(id) } }, res);
    assert.strictEqual(res.statusCode, 404, 'gone after delete');
});

test('create rejects a missing title and a bad language', () => {
    let res = mockRes();
    articles.create({ admin, body: { language: 'bg', blocks: [] } }, res);
    assert.strictEqual(res.statusCode, 400);
    res = mockRes();
    articles.create({ admin, body: { title: 'X', language: 'de', blocks: [] } }, res);
    assert.strictEqual(res.statusCode, 400);
});
