'use strict';

/**
 * rateLimit.js — minimal in-memory sliding-window limiter.
 *
 * Deliberately dependency-free: express-rate-limit's proxy validation needs
 * `trust proxy` configured for a chain that here is client -> Cloudflare ->
 * nginx -> Node, and its built-in header parsing doesn't know about
 * cf-connecting-ip — reading the headers directly avoids that mismatch.
 *
 * IMPORTANT: without a forwarded-IP header every request looks like it comes
 * from one address, so the per-IP bucket degrades into one shared bucket per
 * API key. Since 2026-08-23 nginx forwards X-Forwarded-For
 * (proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;), and
 * clientKey() below prefers Cloudflare's own cf-connecting-ip when present —
 * see the comment there for why that one is authoritative rather than XFF.
 */

/**
 * Best-effort client identity: real IP when the proxy forwards it, else key.
 *
 * The site sits behind Cloudflare (confirmed 2026-08-22: `server: cloudflare`,
 * `cf-ray` on every response). That changes what "the forwarded IP" means:
 *   - cf-connecting-ip is Cloudflare's OWN header, carrying the true visitor
 *     IP. Cloudflare sets it authoritatively and strips any client-supplied
 *     copy before proxying, so it cannot be spoofed by the request itself —
 *     prefer it whenever present.
 *   - x-forwarded-for as seen by nginx is the connecting-hop chain — behind
 *     Cloudflare that is populated by Cloudflare's own forwarding rather than
 *     nginx's $proxy_add_x_forwarded_for reflecting the true client alone, so
 *     it's the correct fallback for direct/non-Cloudflare access (local dev,
 *     health checks from the box itself) but not the first choice in prod.
 */
function clientKey(req) {
    const cf = req.headers['cf-connecting-ip'];
    const fwd = req.headers['x-forwarded-for'];
    const ip = cf || (fwd ? String(fwd).split(',')[0].trim() : (req.ip || req.socket?.remoteAddress || 'unknown'));
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
