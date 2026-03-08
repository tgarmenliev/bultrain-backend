const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// ── Paths ───────────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'bultrain.sqlite');
const GUIDE_DIR = path.join(__dirname, 'guide', 'texts');

// ── Database ────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── 1. Create tables ────────────────────────────────────────────────────────
console.log('Creating tables...');

db.exec(`
  CREATE TABLE IF NOT EXISTS handbook_topics (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    app_topic_id  INTEGER NOT NULL,
    language      TEXT    NOT NULL,
    title         TEXT    NOT NULL,
    subtitle      TEXT,
    cover_image   TEXT,
    sort_order    INTEGER
  );

  CREATE TABLE IF NOT EXISTS handbook_content (
    block_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_pk        INTEGER NOT NULL REFERENCES handbook_topics(id) ON DELETE CASCADE,
    sequence_order  INTEGER NOT NULL,
    text_body       TEXT    NOT NULL,
    image           TEXT
  );
`);

console.log('Tables created (or already exist).');

// ── 2. Clear existing data (idempotent) ─────────────────────────────────────
console.log('Clearing existing handbook data...');
db.exec('DELETE FROM handbook_content;');
db.exec('DELETE FROM handbook_topics;');
console.log('Existing data cleared.');

// ── 3. Prepared statements ──────────────────────────────────────────────────
const insertTopic = db.prepare(`
  INSERT INTO handbook_topics (app_topic_id, language, title, subtitle, cover_image, sort_order)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const insertBlock = db.prepare(`
  INSERT INTO handbook_content (topic_pk, sequence_order, text_body, image)
  VALUES (?, ?, ?, ?)
`);

// ── 4. Transaction for importing a single topic (both languages) ────────────
const importTopic = db.transaction((topicId, data) => {
    const languages = [
        {
            lang: 'bg',
            title: data.title,
            subtitle: data.subtitle || null,
            getText: (block) => block.text,
        },
        {
            lang: 'en',
            title: data.englishTitle,
            subtitle: data.englishSubtitle || null,
            getText: (block) => block.englishText,
        },
    ];

    for (const { lang, title, subtitle, getText } of languages) {
        // Skip language if no title exists for it
        if (!title) {
            console.log(`  [SKIP] Topic ${topicId} - no ${lang.toUpperCase()} title found`);
            continue;
        }

        // Insert topic metadata
        const info = insertTopic.run(
            topicId,        // app_topic_id
            lang,           // language
            title,          // title
            subtitle,       // subtitle
            data.image || null,  // cover_image (e.g. "topic1.jpg")
            topicId         // sort_order = same as app_topic_id
        );
        const topicPk = info.lastInsertRowid;

        // Insert content blocks
        if (data.content && Array.isArray(data.content)) {
            for (let seq = 0; seq < data.content.length; seq++) {
                const block = data.content[seq];
                const textBody = getText(block);

                if (!textBody) {
                    console.log(`  [WARN] Topic ${topicId} (${lang}): content block ${seq} has no text, skipping`);
                    continue;
                }

                insertBlock.run(
                    topicPk,
                    seq,
                    textBody,
                    block.image || null
                );
            }
        }

        const blockCount = data.content ? data.content.length : 0;
        console.log(`  [OK] Topic ${topicId} (${lang}): "${title}" — ${blockCount} block(s)`);
    }
});

// ── 5. Discover and import topic files ──────────────────────────────────────
console.log(`\nScanning directory: ${GUIDE_DIR}\n`);

// Find all topic files: topic1.json, topic2.json, ...
let topicFiles;
try {
    topicFiles = fs.readdirSync(GUIDE_DIR)
        .filter(f => /^topic\d+\.json$/.test(f))
        .sort((a, b) => {
            const numA = parseInt(a.match(/\d+/)[0]);
            const numB = parseInt(b.match(/\d+/)[0]);
            return numA - numB;
        });
} catch (err) {
    console.error(`[FATAL] Cannot read guide directory: ${err.message}`);
    db.close();
    process.exit(1);
}

if (topicFiles.length === 0) {
    console.warn('[WARN] No topic files found in guide/texts/');
    db.close();
    process.exit(0);
}

console.log(`Found ${topicFiles.length} topic file(s).\n`);

let successCount = 0;
let errorCount = 0;

for (const filename of topicFiles) {
    const topicId = parseInt(filename.match(/\d+/)[0]);
    const filePath = path.join(GUIDE_DIR, filename);

    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);

        importTopic(topicId, data);
        successCount++;
    } catch (err) {
        errorCount++;
        console.error(`[ERROR] Topic ${topicId} (${filename}): ${err.message}`);
    }
}

// ── 6. Summary ──────────────────────────────────────────────────────────────
db.close();

console.log(`\n${'='.repeat(50)}`);
console.log('Handbook migration complete.');
console.log(`  Success: ${successCount}`);
console.log(`  Errors:  ${errorCount}`);
console.log(`  Total:   ${topicFiles.length}`);

// Verification counts
const verifyDb = new Database(DB_PATH, { readonly: true });
const topicCount = verifyDb.prepare('SELECT COUNT(*) AS c FROM handbook_topics').get().c;
const blockCount = verifyDb.prepare('SELECT COUNT(*) AS c FROM handbook_content').get().c;
verifyDb.close();

console.log(`\nDB verification:`);
console.log(`  handbook_topics rows: ${topicCount}`);
console.log(`  handbook_content rows: ${blockCount}`);
