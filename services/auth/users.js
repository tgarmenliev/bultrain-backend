'use strict';

/**
 * users.js — the only module that touches the users table. Writable connection
 * (login reads, the create-user script writes). Honours BULTRAIN_DB so tests can
 * point elsewhere.
 */

const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.BULTRAIN_DB || path.join(__dirname, '..', '..', 'bultrain.sqlite');

let db = null;
function conn() {
    if (!db) {
        db = new Database(DB_PATH, { fileMustExist: true });
        db.pragma('foreign_keys = ON');
    }
    return db;
}

const nowIso = () => new Date().toISOString();

/** Active account for a username, or null. */
function findByUsername(username) {
    return conn().prepare(
        'SELECT id, username, password_hash, salt, role, active FROM users WHERE username = ? AND active = 1'
    ).get(String(username || '')) || null;
}

/** Active account for an id (the `uid` carried in the login token), or null. */
function findById(id) {
    return conn().prepare(
        'SELECT id, username, password_hash, salt, role, active FROM users WHERE id = ? AND active = 1'
    ).get(id) || null;
}

/** @returns {boolean} whether an active account was actually updated */
function updatePassword(id, password_hash, salt) {
    return conn().prepare(
        'UPDATE users SET password_hash = ?, salt = ? WHERE id = ? AND active = 1'
    ).run(password_hash, salt, id).changes === 1;
}

function create({ username, password_hash, salt, role = 'author' }) {
    return conn().prepare(
        'INSERT INTO users (username, password_hash, salt, role, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(String(username), password_hash, salt, role, nowIso()).lastInsertRowid;
}

function count() {
    return conn().prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

module.exports = { findByUsername, findById, updatePassword, create, count };
