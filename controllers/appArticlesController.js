'use strict';

/**
 * appArticlesController.js — the app-facing, read-only view of articles.
 * Serves ONLY published travel ideas, in the same envelope the guide already
 * uses ({ title, subtitle, image, content:[{ text, image? }] }) so the app's
 * existing renderer works — with `type` added per block for the new block kinds
 * and the travel metadata at the top.
 *
 * A draft can be fetched too, but only with a valid short-lived preview token
 * minted by the author (see articlesController.previewToken) — so the author can
 * see an unpublished idea in the real app before publishing it.
 */

const path     = require('path');
const Database = require('better-sqlite3');
const jwt      = require('jsonwebtoken');

const DB_PATH = process.env.BULTRAIN_DB || path.join(__dirname, '..', 'bultrain.sqlite');
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

const DEFAULT_CATEGORY = 'travel_idea';
const MAX_LIMIT = 50;

const listStmt = db.prepare(`
    SELECT id, title, subtitle, cover_image, region, season, duration_min, related_train, featured, published_at
    FROM handbook_topics
    WHERE category = ? AND status = 'published'
    ORDER BY featured DESC, published_at DESC
    LIMIT ? OFFSET ?
`);
const countStmt = db.prepare(
    "SELECT COUNT(*) AS c FROM handbook_topics WHERE category = ? AND status = 'published'"
);
const oneStmt    = db.prepare('SELECT * FROM handbook_topics WHERE id = ? AND category = ?');
const blocksStmt = db.prepare(
    'SELECT block_type, text_body, image FROM handbook_content WHERE topic_pk = ? ORDER BY sequence_order'
);

function mapCard(r) {
    return {
        id: r.id,
        title: r.title,
        subtitle: r.subtitle,
        image: r.cover_image,
        region: r.region,
        season: r.season,
        durationMin: r.duration_min,
        relatedTrain: r.related_train,
        featured: !!r.featured,
        publishedAt: r.published_at,
    };
}

/** A preview token is valid only for its own article id. */
function previewAllows(token, id) {
    if (!token) return false;
    try {
        const d = jwt.verify(String(token), process.env.JWT_SECRET);
        return d.purpose === 'article-preview' && d.pv === id;
    } catch {
        return false;
    }
}

/** GET /api/articles?category=travel_idea&limit=&offset= */
exports.list = (req, res) => {
    try {
        const category = req.query.category || DEFAULT_CATEGORY;
        const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
        const articles = listStmt.all(category, limit, offset).map(mapCard);
        res.json({ count: countStmt.get(category).c, articles });
    } catch (e) {
        console.error('[articles/app] list:', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/** GET /api/articles/:id  (published, or a draft with a valid ?preview= token) */
exports.getOne = (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const row = Number.isNaN(id) ? null : oneStmt.get(id, DEFAULT_CATEGORY);
        if (!row) return res.status(404).json({ error: 'Article not found.' });

        if (row.status !== 'published' && !previewAllows(req.query.preview, id)) {
            return res.status(404).json({ error: 'Article not found.' });
        }

        const content = blocksStmt.all(id).map(b => {
            const entry = { type: b.block_type, text: b.text_body };
            if (b.image) entry.image = b.image;
            return entry;
        });

        res.json({
            ...mapCard(row),
            preview: row.status !== 'published' || undefined, // present only for a previewed draft
            content,
        });
    } catch (e) {
        console.error('[articles/app] getOne:', e.message);
        res.status(500).json({ error: 'Internal server error' });
    }
};
