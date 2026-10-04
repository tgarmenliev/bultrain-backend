'use strict';

const snapshot = require('../services/network/snapshot');

/**
 * The public "living network" endpoints for the website. No API key (a key in a
 * web page is not a secret), so everything is read-only, served from memory and
 * rate-limited; CORS is limited to the site and to local development.
 */

const SITE_ORIGINS = [
    'https://bultrain.eu',
    'https://www.bultrain.eu',
    ...String(process.env.SITE_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    // local development
    'http://localhost:5173', 'http://localhost:4173', 'http://localhost:3000',
    'http://127.0.0.1:5173', 'http://127.0.0.1:4173',
];

/** Echo the origin back only when it is one of ours; browsers enforce the rest. */
function cors(req, res) {
    res.set('Vary', 'Origin, Accept-Encoding');
    const origin = req.headers.origin;
    if (origin && SITE_ORIGINS.includes(origin)) res.set('Access-Control-Allow-Origin', origin);
}

const acceptsGzip = (header) => String(header || '').split(',').some(part => {
    const [coding, ...params] = part.trim().split(';').map(s => s.trim());
    if (coding !== 'gzip' && coding !== '*') return false;
    const q = params.find(p => p.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
});

const etagMatches = (header, etag) => !!header && header.split(',').some(t => {
    const v = t.trim();
    return v === '*' || v.replace(/^W\//, '') === etag;
});

const serve = (kind) => (req, res) => {
    cors(req, res);

    const snap = snapshot.get(kind);
    if (!snap) {
        res.set('Retry-After', '15');
        res.set('Cache-Control', 'no-store');
        return res.status(503).json({ error: 'The network snapshot is not ready yet.' });
    }

    // Caches may keep a copy until the next build is due, and not a second
    // longer: a visitor then waits at most one build interval, never two.
    const untilNext = Math.ceil((snap.nextBuildMs - Date.now()) / 1000);
    res.set('Cache-Control', `public, max-age=${Math.min(60, Math.max(5, untilNext))}`);
    res.set('ETag', snap.etag);
    if (etagMatches(req.headers['if-none-match'], snap.etag)) return res.status(304).end();

    const gz = acceptsGzip(req.headers['accept-encoding']);
    const body = gz ? snap.gzip : snap.json;
    res.set('Content-Type', 'application/json; charset=utf-8');
    if (gz) res.set('Content-Encoding', 'gzip');
    res.set('Content-Length', String(body.length));
    res.end(body);
};

exports.getNetwork = serve('network');
exports.getRadar = serve('radar');

/** OPTIONS: a plain GET needs no preflight, but answer one properly if it comes. */
exports.preflight = (req, res) => {
    cors(req, res);
    res.set('Access-Control-Allow-Methods', 'GET, HEAD');
    res.set('Access-Control-Max-Age', '86400');
    res.status(204).end();
};
