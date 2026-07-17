'use strict';

const Database = require('better-sqlite3');
const path     = require('path');

const DB_PATH = path.join(__dirname, '..', 'bultrain.sqlite');

/**
 * Forces the database file into WAL mode, from a writable connection.
 *
 * journal_mode lives in the file header, not on a connection, so this only has
 * to succeed once — but it must happen before any readonly connection opens the
 * file. A database restored from `.dump` comes back in `delete` mode, and
 * `PRAGMA journal_mode = WAL` needs write access: every readonly connection
 * would then throw SQLITE_READONLY at require() time and take the process down
 * before it could serve a single request.
 *
 * @param {string} [dbPath]
 * @returns {string} the resulting journal mode
 */
module.exports = function ensureWal(dbPath = DB_PATH) {
    const db = new Database(dbPath, { fileMustExist: true });
    try {
        const mode = db.pragma('journal_mode = WAL', { simple: true });
        if (mode !== 'wal') {
            throw new Error(`could not switch ${dbPath} to WAL mode (got "${mode}")`);
        }
        return mode;
    } finally {
        db.close();
    }
};
