'use strict';

/**
 * Migration 009 — the articles foundation on top of the handbook model.
 *
 * The point pinned here: it is additive and backwards-safe. A row inserted the
 * old way (no category/status/block_type) must land on the guide defaults so the
 * наръчник keeps working, and a new travel_idea article with the richer blocks
 * and metadata must round-trip.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const Database = require('better-sqlite3');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-art-')), 'test.sqlite');
require('../database/migrate')(TMP);
const db = new Database(TMP);

test('legacy handbook rows fall on the guide defaults', () => {
    // Inserted the OLD way — omitting every column 009 added.
    const t = db.prepare(
        'INSERT INTO handbook_topics (app_topic_id, language, title) VALUES (1, \'bg\', \'Гара по гара\')'
    ).run();
    const topicPk = t.lastInsertRowid;
    db.prepare(
        'INSERT INTO handbook_content (topic_pk, sequence_order, text_body) VALUES (?, 1, \'Първи блок\')'
    ).run(topicPk);

    const topic = db.prepare('SELECT category, status, featured FROM handbook_topics WHERE id = ?').get(topicPk);
    assert.strictEqual(topic.category, 'guide', 'defaults to a guide topic');
    assert.strictEqual(topic.status, 'published', 'existing content stays visible');
    assert.strictEqual(topic.featured, 0);

    const block = db.prepare('SELECT block_type FROM handbook_content WHERE topic_pk = ?').get(topicPk);
    assert.strictEqual(block.block_type, 'paragraph', 'legacy blocks are paragraphs');
});

test('a travel_idea article with rich blocks and metadata round-trips', () => {
    const author = db.prepare(
        'INSERT INTO users (username, password_hash, salt, role) VALUES (\'ana\', \'h\', \'s\', \'author\')'
    ).run().lastInsertRowid;

    const topicPk = db.prepare(`
        INSERT INTO handbook_topics
            (app_topic_id, language, title, subtitle, category, status, featured,
             author_id, region, season, duration_min, related_train, published_at)
        VALUES (100, 'bg', 'Еднодневно до Копривщица', 'С влак от София',
                'travel_idea', 'draft', 1, ?, 'Средногорие', 'есен', 600, '10112', NULL)
    `).run(author).lastInsertRowid;

    for (const [i, [type, body, img]] of [
        ['heading',   'Защо Копривщица', null],
        ['paragraph', 'Тръгва се сутрин…', null],
        ['image',     'Гарата', 'koprivshtitsa.jpg'],
        ['tip',       'Вземи ранния влак', null],
        ['route',     'Влак 10112', null],
    ].entries()) {
        db.prepare(
            'INSERT INTO handbook_content (topic_pk, sequence_order, block_type, text_body, image) VALUES (?,?,?,?,?)'
        ).run(topicPk, i + 1, type, body, img);
    }

    const topic = db.prepare('SELECT * FROM handbook_topics WHERE id = ?').get(topicPk);
    assert.strictEqual(topic.category, 'travel_idea');
    assert.strictEqual(topic.status, 'draft', 'starts as a draft, not visible to the app');
    assert.strictEqual(topic.related_train, '10112');
    assert.strictEqual(topic.duration_min, 600);

    const blocks = db.prepare(
        'SELECT block_type, text_body, image FROM handbook_content WHERE topic_pk = ? ORDER BY sequence_order'
    ).all(topicPk);
    assert.deepStrictEqual(blocks.map(b => b.block_type), ['heading', 'paragraph', 'image', 'tip', 'route']);
    assert.strictEqual(blocks[2].image, 'koprivshtitsa.jpg', 'image block keeps its file');
});

test('users table enforces unique usernames and defaults role to author', () => {
    db.prepare('INSERT INTO users (username, password_hash, salt) VALUES (\'dup\', \'h\', \'s\')').run();
    const row = db.prepare('SELECT role, active FROM users WHERE username = \'dup\'').get();
    assert.strictEqual(row.role, 'author', 'a new account is an author unless told otherwise');
    assert.strictEqual(row.active, 1);
    assert.throws(
        () => db.prepare('INSERT INTO users (username, password_hash, salt) VALUES (\'dup\', \'h2\', \'s2\')').run(),
        /UNIQUE/,
        'the same username cannot be taken twice',
    );
});
