'use strict';

/**
 * articlesController.js — CRUD for handbook_topics content (admin or author
 * role), covering BOTH categories on the shared block-editing tables:
 * 'travel_idea' (author-written articles) and 'guide' (the наръчник).
 *
 * The guide moved here because its old CRUD (adminController.listTopics etc.)
 * only ever managed topic metadata — title/subtitle/cover_image — with no way
 * to edit the actual content blocks through the admin panel at all. This reuses
 * the one block editor for both, rather than building a second one.
 *
 * 'guide' is admin-only: it is official app content, not an author's own
 * article, so an 'author' role is refused for anything guide-category —
 * checked against the ROW'S OWN category (from the DB), never the client's
 * claim, for create/update/delete/publish. See isAdmin()/guardCategory().
 *
 * Blocks are replaced wholesale on save — the editor always sends the full,
 * ordered list — which keeps sequencing trivially correct.
 */

const path     = require('path');
const Database = require('better-sqlite3');
const jwt      = require('jsonwebtoken');

const DB_PATH = process.env.BULTRAIN_DB || path.join(__dirname, '..', 'bultrain.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const CATEGORIES  = new Set(['travel_idea', 'guide']);
const DEFAULT_CATEGORY = 'travel_idea';
const BLOCK_TYPES = new Set(['heading', 'paragraph', 'image', 'quote', 'tip', 'route']);
const LANGS       = new Set(['bg', 'en']);
const TEXT_REQUIRED = new Set(['heading', 'paragraph', 'quote', 'tip']); // image/route may omit text
const nowIso = () => new Date().toISOString();

const isAdmin = (req) => !!(req.admin && req.admin.role === 'admin');
/** 403s unless the caller is admin OR the category isn't the admin-only one. */
function guardCategory(req, res, category) {
    if (category === 'guide' && !isAdmin(req)) {
        res.status(403).json({ error: 'Only admins may edit guide content.' });
        return false;
    }
    return true;
}

/**
 * Validate + normalise an incoming blocks array into rows ready for insert.
 * Pure and exported so the rules are unit-tested directly.
 * @returns {{ok:true, blocks:Array}|{ok:false, error:string}}
 */
function validateBlocks(blocks) {
    if (!Array.isArray(blocks)) return { ok: false, error: 'blocks must be an array.' };
    const out = [];
    for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i] || {};
        const type = b.block_type || 'paragraph';
        if (!BLOCK_TYPES.has(type)) {
            return { ok: false, error: `Unknown block_type "${type}" at block #${i + 1}.` };
        }
        const text = b.text_body == null ? '' : String(b.text_body);
        if (TEXT_REQUIRED.has(type) && !text.trim()) {
            return { ok: false, error: `Block #${i + 1} (${type}) needs text.` };
        }
        if (type === 'image' && !b.image) {
            return { ok: false, error: `Image block #${i + 1} needs an uploaded image.` };
        }
        out.push({ seq: i + 1, block_type: type, text_body: text, image: b.image ? String(b.image) : null });
    }
    return { ok: true, blocks: out };
}

// ── Prepared statements ──────────────────────────────────────────────────────
// category is a bound @param everywhere now, not a literal baked into the SQL
// at module-load time — the same statements now serve either category.
const insTopic = db.prepare(`
    INSERT INTO handbook_topics
        (app_topic_id, language, title, subtitle, cover_image, category, status, featured,
         author_id, region, season, duration_min, related_train, sort_order, created_at, updated_at)
    VALUES
        (0, @language, @title, @subtitle, @cover_image, @category, 'draft', @featured,
         @author_id, @region, @season, @duration_min, @related_train, @sort_order, @now, @now)
`);
const setAppTopicId = db.prepare('UPDATE handbook_topics SET app_topic_id = ? WHERE id = ?');
const nextGuideSortOrder = db.prepare(
    "SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM handbook_topics WHERE category = 'guide'"
);
const insBlock = db.prepare(`
    INSERT INTO handbook_content (topic_pk, sequence_order, block_type, text_body, image)
    VALUES (@topic_pk, @seq, @block_type, @text_body, @image)
`);
const delBlocks = db.prepare('DELETE FROM handbook_content WHERE topic_pk = ?');
// Fetches by id ALONE — category isn't required to find the row (id is the PK),
// but restricted to the two known categories as a sanity guard. Callers check
// the RETURNED row's own category for the admin-only gate, never a client claim.
const getTopic  = db.prepare("SELECT * FROM handbook_topics WHERE id = ? AND category IN ('travel_idea','guide')");
const getBlocks = db.prepare(
    'SELECT block_type, text_body, image FROM handbook_content WHERE topic_pk = ? ORDER BY sequence_order'
);
const listStmt = db.prepare(`
    SELECT t.id, t.title, t.subtitle, t.status, t.featured, t.cover_image,
           t.region, t.season, t.duration_min, t.related_train,
           t.published_at, t.updated_at, u.username AS author
    FROM handbook_topics t
    LEFT JOIN users u ON u.id = t.author_id
    WHERE t.category = ?
    ORDER BY COALESCE(t.updated_at, t.created_at) DESC
`);
const delTopic = db.prepare('DELETE FROM handbook_topics WHERE id = ? AND category = ?');
const updTopic = db.prepare(`
    UPDATE handbook_topics SET
        title = @title, subtitle = @subtitle, cover_image = @cover_image, featured = @featured,
        language = @language, region = @region, season = @season, duration_min = @duration_min,
        related_train = @related_train, updated_at = @now
    WHERE id = @id AND category = @category
`);
const setStatusStmt = db.prepare(`
    UPDATE handbook_topics SET status = @status, published_at = @published_at, updated_at = @now
    WHERE id = @id AND category = @category
`);

const createTx = db.transaction((topic, blocks, category) => {
    // New guide topics must not collide with the sort_order the app-facing
    // guide list already orders by — a NULL default sorts FIRST in SQLite,
    // which would jump a brand-new topic to the top of the list. Existing
    // topics are never touched here (update never sets sort_order), so this
    // only matters for creation. travel_idea ignores sort_order entirely (the
    // app orders articles by published date), so it stays NULL there.
    const sortOrder = category === 'guide' ? nextGuideSortOrder.get().n : null;
    const id = Number(insTopic.run({ ...topic, category, sort_order: sortOrder }).lastInsertRowid);
    setAppTopicId.run(id, id); // new topics are addressed by their own PK either way
    for (const b of blocks) insBlock.run({ topic_pk: id, ...b });
    return id;
});
const updateTx = db.transaction((id, topic, blocks) => {
    updTopic.run({ ...topic, id, now: nowIso() });
    if (blocks !== null) {
        delBlocks.run(id);
        for (const b of blocks) insBlock.run({ topic_pk: id, ...b });
    }
});

// Pull the settable topic fields off the body, coalescing to an existing row.
function topicFields(body, existing) {
    const pick = (k, def) => (body[k] !== undefined ? body[k] : (existing ? existing[k] : def));
    return {
        title:         String(pick('title', '')).trim(),
        subtitle:      pick('subtitle', null) || null,
        cover_image:   pick('cover_image', null) || null,
        featured:      pick('featured', 0) ? 1 : 0,
        language:      pick('language', 'bg'),
        region:        pick('region', null) || null,
        season:        pick('season', null) || null,
        duration_min:  Number.isFinite(+pick('duration_min', null)) && pick('duration_min', null) != null ? Math.trunc(+pick('duration_min', null)) : null,
        related_train: pick('related_train', null) ? String(pick('related_train', null)) : null,
    };
}

// ── Handlers ─────────────────────────────────────────────────────────────────

exports.list = (req, res) => {
    try {
        const category = CATEGORIES.has(req.query.category) ? req.query.category : DEFAULT_CATEGORY;
        if (!guardCategory(req, res, category)) return;
        res.json(listStmt.all(category));
    } catch (e) {
        console.error('[articles] list:', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
};

exports.getOne = (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const topic = Number.isNaN(id) ? null : getTopic.get(id);
        if (!topic) return res.status(404).json({ error: 'Article not found.' });
        // Guard on the ROW's own category, never a client-supplied one — an
        // author guessing a guide id must not be able to read its content.
        if (!guardCategory(req, res, topic.category)) return;
        res.json({ ...topic, blocks: getBlocks.all(id) });
    } catch (e) {
        console.error('[articles] getOne:', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
};

exports.create = (req, res) => {
    try {
        const b = req.body || {};
        const category = CATEGORIES.has(b.category) ? b.category : DEFAULT_CATEGORY;
        if (!guardCategory(req, res, category)) return;

        const fields = topicFields(b, null);
        if (!fields.title) return res.status(400).json({ error: 'title is required.' });
        if (!LANGS.has(fields.language)) return res.status(400).json({ error: 'language must be bg or en.' });

        const v = validateBlocks(b.blocks || []);
        if (!v.ok) return res.status(400).json({ error: v.error });

        const id = createTx(
            { ...fields, author_id: req.admin ? req.admin.uid || null : null, now: nowIso() },
            v.blocks,
            category
        );
        res.status(201).json({ id, category, message: `${category === 'guide' ? 'Topic' : 'Article'} created (draft).` });
    } catch (e) {
        console.error('[articles] create:', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
};

exports.update = (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const existing = Number.isNaN(id) ? null : getTopic.get(id);
        if (!existing) return res.status(404).json({ error: 'Article not found.' });
        if (!guardCategory(req, res, existing.category)) return; // never trust client-claimed category

        const b = req.body || {};
        const fields = topicFields(b, existing);
        if (!fields.title) return res.status(400).json({ error: 'title is required.' });
        if (!LANGS.has(fields.language)) return res.status(400).json({ error: 'language must be bg or en.' });

        let blocks = null; // null = leave blocks untouched
        if (b.blocks !== undefined) {
            const v = validateBlocks(b.blocks);
            if (!v.ok) return res.status(400).json({ error: v.error });
            blocks = v.blocks;
        }

        updateTx(id, { ...fields, category: existing.category }, blocks);
        res.json({ message: 'Article updated.' });
    } catch (e) {
        console.error('[articles] update:', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
};

function changeStatus(req, res, status) {
    const id = parseInt(req.params.id, 10);
    const existing = Number.isNaN(id) ? null : getTopic.get(id);
    if (!existing) return res.status(404).json({ error: 'Article not found.' });
    if (!guardCategory(req, res, existing.category)) return;
    setStatusStmt.run({
        id, status, category: existing.category,
        published_at: status === 'published' ? (existing.published_at || nowIso()) : existing.published_at,
        now: nowIso(),
    });
    res.json({ message: `Article ${status}.` });
}
exports.publish   = (req, res) => { try { changeStatus(req, res, 'published'); } catch (e) { console.error('[articles] publish:', e.message); res.status(500).json({ error: 'Internal server error' }); } };
exports.unpublish = (req, res) => { try { changeStatus(req, res, 'draft'); } catch (e) { console.error('[articles] unpublish:', e.message); res.status(500).json({ error: 'Internal server error' }); } };

exports.remove = (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const existing = Number.isNaN(id) ? null : getTopic.get(id);
        if (!existing) return res.status(404).json({ error: 'Article not found.' });
        if (!guardCategory(req, res, existing.category)) return;

        const changes = delTopic.run(id, existing.category).changes; // blocks cascade via FK
        if (!changes) return res.status(404).json({ error: 'Article not found.' });
        res.json({ message: 'Article deleted.' });
    } catch (e) {
        console.error('[articles] remove:', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * POST /api/admin/articles/:id/preview-token
 * A short-lived token that unlocks THIS draft on the app-facing endpoint, so the
 * author can see an unpublished idea in the real app before publishing.
 */
exports.previewToken = (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const existing = Number.isNaN(id) ? null : getTopic.get(id);
        if (!existing) return res.status(404).json({ error: 'Article not found.' });
        if (!guardCategory(req, res, existing.category)) return;
        const token = jwt.sign({ pv: id, purpose: 'article-preview' }, process.env.JWT_SECRET, { expiresIn: '30m' });
        res.json({
            token,
            url: `/api/articles/${id}?preview=${token}`,          // relative API path (app fetches this)
            deepLink: `bultrain://article/${id}?preview=${token}`, // opens the app on a phone (also the QR value)
            expiresInMinutes: 30,
        });
    } catch (e) {
        console.error('[articles] previewToken:', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
};

exports.validateBlocks = validateBlocks; // exported for tests
