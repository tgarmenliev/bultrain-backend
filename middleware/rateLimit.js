'use strict';

/**
 * rateLimit.js — minimal in-memory sliding-window limiter.
 *
 * Deliberately dependency-free: express-rate-limit's proxy validation needs
 * `trust proxy` configured, and nginx here does not currently forward
 * X-Forwarded-For, so a package would add a footgun without adding accuracy.
 *
 * IMPORTANT: behind nginx without X-Forwarded-For every request looks like it
 * comes from 127.0.0.1, so the per-IP bucket degrades into one shared bucket
 * per API key. That is still a useful flood ceiling, and the per-journey token
 * cap in the controller is the precise control. To get true per-IP limits, add
 *   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
 * to the nginx location block — this module picks it up automatically.
 */

/** Best-effort client identity: real IP when the proxy forwards it, else key. */
function clientKey(req) {
    const fwd = req.headers['x-forwarded-for'];
    const ip = fwd ? String(fwd).split(',')[0].trim() : (req.ip || req.socket?.remoteAddress || 'unknown');
    const apiKey = req.headers['x-bultrain-api-key'] || 'nokey';
    // Only a fingerprint of the key — never log or bucket on the secret itself.
    return `${ip}|${String(apiKey).slice(0, 6)}`;
}

function createRateLimit({ windowMs = 60_000, max = 20, keyFn = clientKey, message } = {}) {
    const hits = new Map(); // key -> number[] (timestamps)

    // Keep the map from growing without bound on a long-running process.
    const sweep = setInterval(() => {
        const cutoff = Date.now() - windowMs;
        for (const [k, times] of hits) {
            const kept = times.filter(t => t > cutoff);
            if (kept.length) hits.set(k, kept); else hits.delete(k);
        }
    }, windowMs);
    if (sweep.unref) sweep.unref();

    return function rateLimit(req, res, next) {
        const key = keyFn(req);
        const now = Date.now();
        const times = (hits.get(key) || []).filter(t => now - t < windowMs);

        if (times.length >= max) {
            res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
            return res.status(429).json({ error: message || 'Too many requests. Slow down.' });
        }

        times.push(now);
        hits.set(key, times);
        next();
    };
}

module.exports = { createRateLimit, clientKey };
