const Database = require('better-sqlite3');
const path = require('path');

// ── Database ────────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, '..', 'bultrain.sqlite');
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// ── Prepared statements ─────────────────────────────────────────────────────
const stmtTopic = db.prepare(`
    SELECT id, app_topic_id, title, subtitle, cover_image
    FROM handbook_topics
    WHERE language = ? AND app_topic_id = ?
`);

const stmtContent = db.prepare(`
    SELECT text_body, image
    FROM handbook_content
    WHERE topic_pk = ?
    ORDER BY sequence_order ASC
`);

// ── Controller ──────────────────────────────────────────────────────────────

/**
 * GET /api/guide/:language/:topic
 * Returns a single guide topic with its content blocks.
 */
exports.getGuideTopic = (req, res) => {
    const { language, topic } = req.params;

    if (language !== 'bg' && language !== 'en') {
        return res.status(400).json({ error: 'Language not provided' });
    }

    const topicId = parseInt(topic);
    if (isNaN(topicId)) {
        return res.status(400).json({ error: 'Bad Request! Please provide valid number for topic!' });
    }

    try {
        const row = stmtTopic.get(language, topicId);
        if (!row) {
            return res.status(404).json({ error: 'Topic not found!' });
        }

        const blocks = stmtContent.all(row.id);

        // Build content array — omit image key entirely when NULL
        const content = blocks.map(block => {
            const entry = { text: block.text_body };
            if (block.image) {
                entry.image = block.image;
            }
            return entry;
        });

        const result = {
            title: row.title,
            subtitle: row.subtitle,
            image: row.cover_image,
            content,
        };

        res.header('Content-Type', 'application/json');
        res.send(JSON.stringify(result, null, 4));

    } catch (error) {
        console.error('guideController error:', error);
        res.status(500).json({ error: 'Internal Server Error with access to guide topic!' });
    }
};
