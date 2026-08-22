'use strict';

/**
 * fcm.js — FCM sender for Android, sibling to apns.js.
 *
 * Deliberately NOT firebase-admin. That SDK exists mostly to hide OAuth token
 * refresh and transport, and this project already has both: axios is a
 * dependency the poller uses, and jsonwebtoken signs the APNs provider token.
 * The whole FCM v1 protocol needed here is "sign a service-account JWT, trade
 * it for an access token, POST JSON" — about eighty lines. Pulling in
 * firebase-admin's dependency tree to save those eighty lines would be the
 * single largest addition to package.json in the project, on a box that also
 * runs the database, for no capability we'd use.
 *
 * Mirrors apns.js on purpose: same send() shape, same classify() vocabulary, so
 * armedWatcher branches on platform for the payload and nothing else.
 */

const axios = require('axios');
const fs    = require('fs');
const jwt   = require('jsonwebtoken');

const metrics = require('./metrics');

const TOKEN_URL   = 'https://oauth2.googleapis.com/token';
const SCOPE       = 'https://www.googleapis.com/auth/firebase.messaging';
const REQUEST_TIMEOUT = 10000;
// Google's access tokens last an hour; refresh early so a request never races
// the expiry, the same margin apns.js keeps for its provider JWT.
const TOKEN_REFRESH_MS = 55 * 60 * 1000;

// ── Configuration ────────────────────────────────────────────────────────────

/**
 * Accepts either the whole service-account JSON (contents or a path, via
 * FCM_SERVICE_ACCOUNT) or the three fields it needs individually — the same
 * flexibility APNS_KEY_P8 offers, because multi-line secrets in a .env file are
 * awkward and a path on the server is usually cleaner.
 */
function config() {
    const raw = process.env.FCM_SERVICE_ACCOUNT;
    if (raw) {
        try {
            const json = raw.trim().startsWith('{')
                ? JSON.parse(raw)
                : JSON.parse(fs.readFileSync(raw, 'utf8'));
            return {
                projectId:   json.project_id,
                clientEmail: json.client_email,
                privateKey:  json.private_key,
            };
        } catch (err) {
            console.error('[fcm] FCM_SERVICE_ACCOUNT unreadable:', err.message);
            return { projectId: null, clientEmail: null, privateKey: null };
        }
    }
    return {
        projectId:   process.env.FCM_PROJECT_ID,
        clientEmail: process.env.FCM_CLIENT_EMAIL,
        // Escaped newlines are how a PEM usually survives a .env file.
        privateKey:  (process.env.FCM_PRIVATE_KEY || '').replace(/\\n/g, '\n') || null,
    };
}

/** True when FCM can actually be used. Registration must work regardless. */
function isConfigured() {
    const c = config();
    return !!(c.projectId && c.clientEmail && c.privateKey);
}

// ── Access token (cached) ────────────────────────────────────────────────────

let cached = { token: null, issuedAt: 0 };

async function accessToken({ force = false } = {}) {
    if (!force && cached.token && (Date.now() - cached.issuedAt) < TOKEN_REFRESH_MS) {
        return cached.token;
    }
    const c = config();
    if (!c.privateKey) throw new Error('FCM service account is not configured');

    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign(
        { iss: c.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 },
        c.privateKey,
        { algorithm: 'RS256' }
    );

    const res = await axios.post(
        TOKEN_URL,
        new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion,
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: REQUEST_TIMEOUT }
    );

    cached = { token: res.data.access_token, issuedAt: Date.now() };
    return cached.token;
}

// ── Error classification ─────────────────────────────────────────────────────

/**
 * Map an FCM response onto the SAME vocabulary apns.js uses, so armedWatcher
 * can branch on outcome without caring which sender produced it.
 *
 * FCM v1 reports the useful part in error.details[].errorCode rather than the
 * HTTP status, e.g. UNREGISTERED for a token the device has thrown away.
 */
function classify(status, errorCode) {
    if (status === 200) return 'ok';
    if (errorCode === 'UNREGISTERED' || errorCode === 'INVALID_ARGUMENT') return 'invalid-token';
    if (status === 404) return 'invalid-token';
    if (status === 401 || status === 403 || errorCode === 'SENDER_ID_MISMATCH') return 'auth';
    if (status === 429 || errorCode === 'QUOTA_EXCEEDED') return 'rate-limited';
    if (status >= 500 || errorCode === 'UNAVAILABLE' || errorCode === 'INTERNAL') return 'server';
    return 'error';
}

/** Pull the FcmError code out of a v1 error body, if there is one. */
function errorCodeOf(body) {
    try {
        const details = body && body.error && body.error.details;
        if (Array.isArray(details)) {
            for (const d of details) if (d && d.errorCode) return d.errorCode;
        }
        return (body && body.error && body.error.status) || null;
    } catch {
        return null;
    }
}

// ── Sending ──────────────────────────────────────────────────────────────────

async function postOnce({ token, data, accessTok }) {
    const c = config();
    const started = Date.now();
    try {
        const res = await axios.post(
            `https://fcm.googleapis.com/v1/projects/${c.projectId}/messages:send`,
            {
                message: {
                    token,
                    // A DATA message, never a notification message: the Android app
                    // must run its own code on receipt (it rebuilds the ongoing
                    // notification itself), and a notification message would have
                    // the OS draw a bare one instead while the app slept.
                    data,
                    android: { priority: 'high' },
                },
            },
            {
                headers: { Authorization: `Bearer ${accessTok}`, 'Content-Type': 'application/json' },
                timeout: REQUEST_TIMEOUT,
                validateStatus: () => true,   // classify ourselves, never throw on 4xx/5xx
            }
        );
        metrics.observeLatency(Date.now() - started);
        return { status: res.status, body: res.data };
    } catch (err) {
        metrics.observeLatency(Date.now() - started);
        throw err;
    }
}

/**
 * Send one data message. Same contract as apns.send: never throws for a
 * delivery problem, always reports an outcome the caller can branch on.
 *
 * `data` values must all be strings — FCM rejects a data message whose values
 * are numbers or booleans, which is an easy way to break this silently.
 *
 * @returns {{ outcome: string, status: number, reason: string|null }}
 */
async function send({ token, data, noRetry = false }) {
    const payload = {};
    for (const [k, v] of Object.entries(data || {})) {
        if (v !== undefined && v !== null) payload[k] = String(v);
    }

    let tok;
    try {
        tok = await accessToken();
    } catch (err) {
        metrics.apnsError('fcm-auth');
        return { outcome: 'auth', status: 0, reason: err.message };
    }

    let res;
    try {
        res = await postOnce({ token, data: payload, accessTok: tok });
    } catch (err) {
        metrics.apnsError('fcm-transport');
        return { outcome: 'server', status: 0, reason: err.message };
    }

    let code = errorCodeOf(res.body);
    let outcome = classify(res.status, code);

    // noRetry mirrors the push-to-start rule on the Apple side. FCM has no
    // scarce per-device start budget to protect, but keeping the same
    // single-attempt discipline means one runaway journey cannot hammer a
    // handset regardless of which platform it is on.
    if (noRetry) {
        if (outcome === 'ok') metrics.inc('live_activity_pushes_sent');
        else metrics.apnsError(code || `fcm_http_${res.status}`);
        return { outcome, status: res.status, reason: code };
    }

    // A rejected access token is a configuration problem, not a transient one:
    // mint a fresh one, try once more, then let it be loud.
    if (outcome === 'auth') {
        try {
            tok = await accessToken({ force: true });
            res = await postOnce({ token, data: payload, accessTok: tok });
            code = errorCodeOf(res.body);
            outcome = classify(res.status, code);
        } catch (err) {
            return { outcome: 'server', status: 0, reason: err.message };
        }
        if (outcome === 'auth') {
            console.error('[fcm] FCM rejected our credentials twice — check FCM_SERVICE_ACCOUNT / FCM_PROJECT_ID');
        }
    }

    if (outcome === 'server') {
        await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
        try {
            res = await postOnce({ token, data: payload, accessTok: tok });
            code = errorCodeOf(res.body);
            outcome = classify(res.status, code);
        } catch (err) {
            return { outcome: 'server', status: 0, reason: err.message };
        }
    }

    if (outcome === 'ok') metrics.inc('live_activity_pushes_sent');
    else metrics.apnsError(code || `fcm_http_${res.status}`);

    return { outcome, status: res.status, reason: code };
}

module.exports = { send, isConfigured, classify, errorCodeOf, accessToken };
