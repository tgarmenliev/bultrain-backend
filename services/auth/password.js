'use strict';

/**
 * password.js — salted password hashing with Node's built-in crypto.scrypt,
 * so authors can have real accounts without adding a bcrypt-style dependency.
 *
 * Each password gets its own random salt; verification is constant-time. Stored
 * as two hex columns on the users row (password_hash + salt).
 */

const crypto = require('crypto');

const KEY_LEN    = 64;   // derived key length in bytes
const SALT_BYTES = 16;

/** @returns {{ hash: string, salt: string }} both hex-encoded */
function hash(password) {
    const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
    const derived = crypto.scryptSync(String(password), salt, KEY_LEN).toString('hex');
    return { hash: derived, salt };
}

/** Constant-time check of a password against a stored hash + salt. */
function verify(password, expectedHashHex, salt) {
    if (!password || !expectedHashHex || !salt) return false;
    const expected = Buffer.from(expectedHashHex, 'hex');
    const derived = crypto.scryptSync(String(password), salt, KEY_LEN);
    // timingSafeEqual throws on length mismatch, so guard first.
    return expected.length === derived.length && crypto.timingSafeEqual(derived, expected);
}

module.exports = { hash, verify };
