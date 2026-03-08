const Database = require('better-sqlite3');
const path = require('path');

// ── Database ────────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, '..', 'bultrain.sqlite');
const db = new Database(DB_PATH, { readonly: true });
db.pragma('journal_mode = WAL');

// ── Prepared statement ──────────────────────────────────────────────────────
const stmtAllTopics = db.prepare(`
    SELECT app_topic_id, title, subtitle, cover_image
    FROM handbook_topics
    WHERE language = ?
    ORDER BY sort_order ASC
`);

// ── Controller ──────────────────────────────────────────────────────────────

/**
 * GET /api/guide/:language
 * Returns all guide topics for a language.
 */
exports.getAllTopics = (req, res) => {
    const { language } = req.params;

    if (language !== 'bg' && language !== 'en') {
        return res.status(400).json({ error: 'Bad request! Language not provided!' });
    }

    try {
        const rows = stmtAllTopics.all(language);

        const topics = rows.map(row => ({
            id: row.app_topic_id,
            title: row.title,
            subtitle: row.subtitle,
            image: row.cover_image,
        }));

        res.header('Content-Type', 'application/json');
        res.send(JSON.stringify(topics, null, 4));

    } catch (error) {
        console.error('guideTopicsController error:', error);
        res.status(500).json({ error: 'Internal Server Error with access to the guide!' });
    }
};
