'use strict';

/**
 * apns.js — APNs sender for Live Activity updates.
 *
 * Uses Node's built-in http2 (HTTP/2 is mandatory for APNs) and the
 * jsonwebtoken dependency the project already has, so this adds no packages.
 *
 * Two things here are performance/reliability critical:
 *   * The ES256 provider JWT is CACHED and regenerated about every 50 minutes.
 *     Apple rejects tokens younger than 20 or older than 60 minutes, and
 *     signing ES256 per push is a real CPU cost.
 *   * ONE persistent HTTP/2 session per environment, reconnected with backoff.
 *     APNs closes idle connections and sends GOAWAY; that must not fail a batch.
 *
 * Sandbox vs production is chosen per token, from the environment recorded at
 * registration. Sending to the wrong host returns BadDeviceToken and is the
 * number one first-run failure.
 */

const http2 = require('http2');
const fs    = require('fs');
const jwt   = require('jsonwebtoken');

const metrics = require('./metrics');

const HOSTS = {
    production: 'https://api.push.apple.com',
    sandbox:    'https://api.sandbox.push.apple.com',
};

const JWT_REFRESH_MS   = 50 * 60 * 1000;
const REQUEST_TIMEOUT  = 10000;
const MAX_IN_FLIGHT    = 25;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS  = 30000;

// ── Configuration ────────────────────────────────────────────────────────────

function readKey() {
    const raw = process.env.APNS_KEY_P8;
    if (!raw) return null;
    // Accept either the PEM contents (optionally with escaped newlines, which is
    // how multi-line secrets usually survive an .env file) or a path to the .p8.
    if (raw.includes('BEGIN PRIVATE KEY')) return raw.replace(/\\n/g, '\n');
    try {
        return fs.readFileSync(raw, 'utf8');
    } catch {
        return null;
    }
}

function config() {
    return {
        key:      readKey(),
        keyId:    process.env.APNS_KEY_ID,
        teamId:   process.env.APNS_TEAM_ID,
        bundleId: process.env.APNS_BUNDLE_ID,
        defaultEnv: process.env.APNS_DEFAULT_ENV === 'production' ? 'production' : 'sandbox',
    };
}

/** True when APNs can actually be used. Registration must work regardless. */
function isConfigured() {
    const c = config();
    return !!(c.key && c.keyId && c.teamId && c.bundleId);
}

// ── Provider token (cached) ──────────────────────────────────────────────────

let cached = { token: null, issuedAt: 0 };

function providerToken({ force = false } = {}) {
    const c = config();
    if (!c.key) throw new Error('APNS_KEY_P8 is not configured');
    if (!force && cached.token && (Date.now() - cached.issuedAt) < JWT_REFRESH_MS) {
        return cached.token;
    }
    const token = jwt.sign(
        { iss: c.teamId, iat: Math.floor(Date.now() / 1000) },
        c.key,
        { algorithm: 'ES256', header: { alg: 'ES256', kid: c.keyId } }
    );
    cached = { token, issuedAt: Date.now() };
    return token;
}

// ── Persistent HTTP/2 sessions ───────────────────────────────────────────────

const sessions = {};        // env -> ClientHttp2Session
const reconnectAt = {};     // env -> earliest ms epoch we may reconnect
const backoff = {};         // env -> current backoff in ms

function dropSession(env, session) {
    if (sessions[env] === session) sessions[env] = null;
}

function getSession(env) {
    const existing = sessions[env];
    if (existing && !existing.closed && !existing.destroyed) return existing;

    if (reconnectAt[env] && Date.now() < reconnectAt[env]) {
        throw new Error(`APNs ${env} session backing off`);
    }

    const session = http2.connect(HOSTS[env]);
    sessions[env] = session;

    session.on('connect', () => { backoff[env] = 0; reconnectAt[env] = 0; });
    // GOAWAY / close / error all mean the same thing to us: build a new session
    // next time, after a growing delay so we never hammer Apple.
    const scheduleReconnect = () => {
        dropSession(env, session);
        backoff[env] = Math.min(RECONNECT_MAX_MS, (backoff[env] || RECONNECT_BASE_MS) * 2);
        reconnectAt[env] = Date.now() + backoff[env];
    };
    session.on('goaway', () => dropSession(env, session));
    session.on('close', () => dropSession(env, session));
    session.on('error', (err) => {
        console.error(`[la] APNs ${env} session error:`, err.message);
        scheduleReconnect();
    });

    return session;
}

/** Close both sessions (used by tests and graceful shutdown). */
function closeSessions() {
    for (const env of Object.keys(sessions)) {
        const s = sessions[env];
        if (s && !s.closed) s.close();
        sessions[env] = null;
    }
}

// ── Error classification ─────────────────────────────────────────────────────

/**
 * Map an APNs response onto an action, so callers never branch on raw codes.
 *   'ok'            delivered
 *   'invalid-token' the token is dead — delete the row, never retry
 *   'auth'          provider JWT problem — regenerate and retry once, then log
 *   'rate-limited'  back off this token
 *   'server'        transient — one retry, then let the next tick catch up
 *   'error'         anything else (payload/topic mistakes) — log, do not retry
 */
function classify(status, reason) {
    if (status === 200) return 'ok';
    if (status === 410) return 'invalid-token';
    if (status === 400 && (reason === 'BadDeviceToken' || reason === 'Unregistered')) return 'invalid-token';
    if (status === 403 || reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken') return 'auth';
    if (status === 429 || reason === 'TooManyRequests') return 'rate-limited';
    if (status >= 500) return 'server';
    return 'error';
}

// ── Sending ──────────────────────────────────────────────────────────────────

function postOnce({ token, environment, body, priority, expiration }) {
    return new Promise((resolve, reject) => {
        let session;
        try {
            session = getSession(environment);
        } catch (err) {
            return reject(err);
        }

        const c = config();
        const started = Date.now();
        const req = session.request({
            ':method': 'POST',
            ':path': `/3/device/${token}`,
            'authorization': `bearer ${providerToken()}`,
            'apns-topic': `${c.bundleId}.push-type.liveactivity`,
            'apns-push-type': 'liveactivity',
            'apns-priority': String(priority),
            'apns-expiration': String(expiration),
            'content-type': 'application/json',
        });

        let status = 0;
        let data = '';
        req.setEncoding('utf8');
        req.setTimeout(REQUEST_TIMEOUT, () => {
            req.close(http2.constants.NGHTTP2_CANCEL);
            reject(new Error('APNs request timed out'));
        });
        req.on('response', (headers) => { status = Number(headers[':status']); });
        req.on('data', (chunk) => { data += chunk; });
        req.on('error', reject);
        req.on('end', () => {
            metrics.observeLatency(Date.now() - started);
            let reason = null;
            if (data) { try { reason = JSON.parse(data).reason || null; } catch { /* non-JSON body */ } }
            resolve({ status, reason });
        });

        req.end(body);
    });
}

/**
 * Send one push. `body` must already be serialised — the worker builds it once
 * per train and reuses it across that train's tokens.
 *
 * @returns {{ outcome: string, status: number, reason: string|null }}
 */
async function send({ token, environment, body, priority = 5, expiration }) {
    const env = HOSTS[environment] ? environment : config().defaultEnv;
    const exp = expiration ?? Math.floor(Date.now() / 1000) + 600;

    let res;
    try {
        res = await postOnce({ token, environment: env, body, priority, expiration: exp });
    } catch (err) {
        metrics.apnsError('transport');
        return { outcome: 'server', status: 0, reason: err.message };
    }

    let outcome = classify(res.status, res.reason);

    // A stale or malformed provider token is a configuration problem, not a
    // transient one: regenerate once, retry once, then let it be loud.
    if (outcome === 'auth') {
        providerToken({ force: true });
        try {
            res = await postOnce({ token, environment: env, body, priority, expiration: exp });
            outcome = classify(res.status, res.reason);
        } catch (err) {
            return { outcome: 'server', status: 0, reason: err.message };
        }
        if (outcome === 'auth') {
            console.error('[la] APNs rejected the provider token twice — check APNS_KEY_ID / APNS_TEAM_ID / APNS_KEY_P8');
        }
    }

    // One jittered retry for 5xx; beyond that the next tick carries fresher state.
    if (outcome === 'server') {
        await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
        try {
            res = await postOnce({ token, environment: env, body, priority, expiration: exp });
            outcome = classify(res.status, res.reason);
        } catch (err) {
            return { outcome: 'server', status: 0, reason: err.message };
        }
    }

    if (outcome === 'ok') metrics.inc('live_activity_pushes_sent');
    else metrics.apnsError(res.reason || `http_${res.status}`);

    return { outcome, status: res.status, reason: res.reason };
}

/**
 * Run `tasks` with a hard cap on in-flight requests. Never Promise.all an
 * unbounded array — that is what turns a busy minute into a thundering herd.
 */
async function sendAll(tasks, limit = MAX_IN_FLIGHT) {
    const results = [];
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
        while (next < tasks.length) {
            const i = next++;
            results[i] = await tasks[i]();
        }
    });
    await Promise.all(workers);
    return results;
}

module.exports = {
    send, sendAll, isConfigured, providerToken, classify, closeSessions,
    config, MAX_IN_FLIGHT, HOSTS,
};
