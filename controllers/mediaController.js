'use strict';

/**
 * mediaController.js — image uploads for the article/guide editor.
 *
 * Files land in guide/images/, which is already served at /guide/images/ (and
 * proxied by nginx). To match how the handbook already stores images, cover and
 * block images are referenced by BARE FILENAME; this endpoint returns that name
 * (plus a convenience URL) for the editor to save into the row.
 *
 * The filename is server-generated from the MIME type — never from the uploaded
 * name — so there is no path-traversal or extension-spoofing surface.
 */

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

const MEDIA_DIR = path.join(__dirname, '..', 'guide', 'images');
const MAX_BYTES = 6 * 1024 * 1024; // 6 MB is plenty for an article photo

// Only real, web-safe image types; the extension comes from here, not the client.
const MIME_EXT = {
    'image/jpeg': 'jpg',
    'image/png':  'png',
    'image/webp': 'webp',
};

const extForMime = (mime) => MIME_EXT[mime] || null;

/** Unique, safe filename for an accepted MIME type, or null if unsupported. */
function makeFilename(mime) {
    const ext = extForMime(mime);
    if (!ext) return null;
    return `art-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
}

function ensureDir() {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

/**
 * POST /api/admin/media  (admin or author)
 * multipart/form-data, field "file". Multer has already validated and written
 * the file by the time we get here; we just report where it lives.
 */
function uploadMedia(req, res) {
    if (!req.file) {
        return res.status(400).json({ error: 'No image uploaded — send one file in the "file" field.' });
    }
    res.json({ filename: req.file.filename, url: `/guide/images/${req.file.filename}` });
}

module.exports = { uploadMedia, extForMime, makeFilename, ensureDir, MEDIA_DIR, MAX_BYTES, MIME_EXT };
