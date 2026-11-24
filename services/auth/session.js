'use strict';

/**
 * session.js — the admin panel's login session: how long it lasts, and how it ends.
 *
 * It used to be 8 hours flat, so someone who works in the panel every day or two signed in
 * again each time. Now it lasts ADMIN_SESSION_DAYS (30 by default) and is SLIDING: a request on
 * a session older than a day issues a fresh one, so using the panel at least once a month keeps
 * you in for good.
 *
 * A long session is only acceptable if it can also be ended, so for an account in the users
 * table the token carries a fingerprint of the password it was issued under (`pv`) and is
 * checked against the account on every request (verifyRole): changing the password, disabling
 * the account, or changing its role takes effect at once, on every device. The legacy
 * ADMIN_PASSWORD login has no account to check; rotating JWT_SECRET ends all of those.
 */

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');

const DAY_MS = 24 * 60 * 60 * 1000;

const sessionDays = () => {
    const n = Number(process.env.ADMIN_SESSION_DAYS);
    return Number.isFinite(n) && n > 0 ? n : 30;
};

// A session older than this is replaced by a fresh one on its next request.
const RENEW_AFTER_MS = DAY_MS;

/** What a password looks like to a token: enough to notice it changed, useless to anyone who sees it. */
function passwordFingerprint(passwordHash) {
    return crypto.createHash('sha256').update(String(passwordHash)).digest('hex').slice(0, 16);
}

/** The payload of a login token for an account (or null for the legacy single-password admin). */
function payloadForUser(user) {
    return { role: user.role, username: user.username, uid: user.id, pv: passwordFingerprint(user.password_hash) };
}

/** Sign a token and set it as the session cookie. `payload` is copied, never mutated. */
function issue(res, payload) {
    const days = sessionDays();
    const token = jwt.sign(
        { ...payload, iat: Math.floor(Date.now() / 1000) },
        process.env.JWT_SECRET,
        { expiresIn: `${days}d` }
    );
    res.cookie('admin_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: days * DAY_MS,
    });
    return token;
}

/** Is this decoded token old enough to be replaced? */
function dueForRenewal(decoded, nowMs = Date.now()) {
    return typeof decoded.iat === 'number' && nowMs - decoded.iat * 1000 > RENEW_AFTER_MS;
}

module.exports = { issue, payloadForUser, passwordFingerprint, dueForRenewal, sessionDays, RENEW_AFTER_MS };
