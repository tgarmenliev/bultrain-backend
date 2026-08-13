-- 009_articles.sql
--
-- Foundation for author-written articles ("еднодневни идеи за пътуване с влак"),
-- built ON TOP of the existing handbook model rather than a parallel one: the
-- app already renders handbook_topics + ordered handbook_content blocks, so
-- articles reuse that shape and the app's existing renderer.
--
-- Everything here is additive and backwards-safe. Existing handbook rows get
-- sensible defaults (category 'guide', status 'published', block_type
-- 'paragraph'), so the наръчник keeps working untouched.
--
-- SQLite notes honoured below: one ADD COLUMN per statement; added columns use
-- only CONSTANT defaults (CURRENT_TIMESTAMP is rejected by ALTER TABLE ADD
-- COLUMN, so created_at/updated_at are nullable and set by the app on write);
-- the users table is created BEFORE handbook_topics.author_id references it.

-- ── Authors ──────────────────────────────────────────────────────────────────
-- Own logins with a role, so the friend gets an 'author' account that touches
-- only articles, never trains/schedules. Passwords hashed with Node's built-in
-- crypto.scrypt (no new dependency) — hence separate salt + hash columns.
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    salt          TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'author',  -- 'admin' | 'author'
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT
);

-- ── Topic-level article fields ───────────────────────────────────────────────
ALTER TABLE handbook_topics ADD COLUMN category      TEXT    NOT NULL DEFAULT 'guide';       -- 'guide' | 'travel_idea'
ALTER TABLE handbook_topics ADD COLUMN status        TEXT    NOT NULL DEFAULT 'published';   -- 'draft' | 'published'
ALTER TABLE handbook_topics ADD COLUMN featured      INTEGER NOT NULL DEFAULT 0;             -- highlight in the app
ALTER TABLE handbook_topics ADD COLUMN author_id     INTEGER REFERENCES users(id);
ALTER TABLE handbook_topics ADD COLUMN published_at  TEXT;
ALTER TABLE handbook_topics ADD COLUMN created_at    TEXT;
ALTER TABLE handbook_topics ADD COLUMN updated_at    TEXT;

-- Structured metadata for travel ideas — powers filters and a "see this train"
-- deep link in the app. All optional; guide topics simply leave them NULL.
ALTER TABLE handbook_topics ADD COLUMN region        TEXT;
ALTER TABLE handbook_topics ADD COLUMN season        TEXT;
ALTER TABLE handbook_topics ADD COLUMN duration_min  INTEGER;
ALTER TABLE handbook_topics ADD COLUMN related_train TEXT;

-- ── Richer content blocks ────────────────────────────────────────────────────
-- Existing rows become 'paragraph'; the editor can now also emit heading /
-- image / quote / tip / route blocks. text_body stays NOT NULL (an image
-- block uses it as the caption, empty string when none).
ALTER TABLE handbook_content ADD COLUMN block_type TEXT NOT NULL DEFAULT 'paragraph';

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_topics_category_status ON handbook_topics(category, status);
CREATE INDEX IF NOT EXISTS idx_topics_author          ON handbook_topics(author_id);
