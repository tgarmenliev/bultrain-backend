'use strict';

/**
 * download.js — fetch, verify, and archive the latest GTFS static feed.
 *
 * Two-step resolve (the download id rotates daily), sha256 verification against
 * the checksum the portal publishes, and a versioned archive under data/gtfs/
 * so a bad feed can be rolled back and successive feeds diffed.
 *
 * Usage:  node services/gtfs/download.js [--force]
 *   as a module:  const { downloadLatest } = require('./services/gtfs/download');
 */

const axios  = require('axios');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const cfg = require('./config');

const HTTP_TIMEOUT_MS = 60000;

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Resolve the current latest static file record.
 * @returns {Promise<{id, filename, checksum}>}
 */
async function resolveLatest(subset = cfg.STATIC_SUBSET) {
    const res = await axios.get(cfg.filesUrl(subset), {
        timeout: HTTP_TIMEOUT_MS,
        headers: { Accept: 'application/json' },
    });

    // The portal returns a bare array; tolerate a wrapped {content|data} too.
    const files = Array.isArray(res.data)
        ? res.data
        : (res.data.content || res.data.data || []);

    const latest = files.find(f => f.is_latest);
    if (!latest) throw new Error('no file marked is_latest in the NAP response');
    if (!latest.id) throw new Error('is_latest file record has no id');

    return {
        id:       latest.id,
        filename: latest.filename || latest.name || `${latest.id}.zip`,
        checksum: latest.checksum || null,
    };
}

/**
 * Download the latest static feed, verify it, and archive it.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.force] re-download even if the archived copy matches
 * @returns {Promise<{path, filename, checksum, id, cached:boolean}>}
 */
async function downloadLatest({ force = false } = {}) {
    fs.mkdirSync(cfg.ARCHIVE_DIR, { recursive: true });

    const meta        = await resolveLatest();
    const archivePath = path.join(cfg.ARCHIVE_DIR, meta.filename);

    // Skip the transfer if we already hold a byte-identical copy.
    if (!force && meta.checksum && fs.existsSync(archivePath)) {
        const have = sha256(fs.readFileSync(archivePath));
        if (have === meta.checksum) {
            return { ...meta, path: archivePath, cached: true };
        }
    }

    const res = await axios.get(cfg.downloadUrl(meta.id), {
        timeout: HTTP_TIMEOUT_MS,
        responseType: 'arraybuffer',
        maxContentLength: 100 * 1024 * 1024,
    });
    const buf = Buffer.from(res.data);

    // A download you have not verified is not a download.
    if (meta.checksum) {
        const got = sha256(buf);
        if (got !== meta.checksum) {
            throw new Error(`checksum mismatch: expected ${meta.checksum}, got ${got}`);
        }
    }

    // Atomic write: temp then rename, so a crash mid-write never leaves a
    // truncated file that looks valid.
    const tmp = `${archivePath}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, archivePath);

    pruneArchive();

    return { ...meta, path: archivePath, cached: false };
}

/** Keep only the newest ARCHIVE_KEEP zips. */
function pruneArchive() {
    const zips = fs.readdirSync(cfg.ARCHIVE_DIR)
        .filter(f => f.endsWith('.zip'))
        .map(f => ({ f, t: fs.statSync(path.join(cfg.ARCHIVE_DIR, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
    for (const { f } of zips.slice(cfg.ARCHIVE_KEEP)) {
        fs.unlinkSync(path.join(cfg.ARCHIVE_DIR, f));
    }
}

if (require.main === module) {
    const force = process.argv.includes('--force');
    downloadLatest({ force })
        .then(r => {
            console.log(r.cached ? '[=] already have latest (checksum match)' : '[+] downloaded');
            console.log(`    file:     ${r.filename}`);
            console.log(`    id:       ${r.id}`);
            console.log(`    checksum: ${r.checksum || '(none published)'}`);
            console.log(`    path:     ${r.path}`);
        })
        .catch(err => {
            console.error(`download failed: ${err.message}`);
            process.exit(1);
        });
}

module.exports = { resolveLatest, downloadLatest };
