'use strict';

const bundles   = require('../services/gtfs/routeShapeBundle');
const adminView = require('../services/gtfs/adminView');   // isValidYmd / sofiaToday only
const { etagMatches, acceptsGzip } = require('../services/httpCache');

/** The date to serve: ?date=YYYY-MM-DD (any valid day, yesterday included), else today in Sofia. */
function dateOf(req, res) {
    const date = req.query.date === undefined ? adminView.sofiaToday() : req.query.date;
    if (!adminView.isValidYmd(date)) {
        res.status(400).json({ error: 'date must be YYYY-MM-DD.' });
        return null;
    }
    return date;
}

async function load(req, res) {
    const date = dateOf(req, res);
    if (!date) return null;
    let bundle;
    try {
        bundle = await bundles.bundleFor(date);
    } catch (err) {
        console.error('routeShapesController error:', err);
        res.status(500).json({ error: 'Internal server error' });
        return null;
    }
    if (!bundle) {
        res.status(404).json({ error: 'No route shapes for this date.' });
        return null;
    }
    return bundle;
}

/**
 * GET /api/route-shapes?date=YYYY-MM-DD
 * Every shape of the service day, deduplicated, plus which shape each train uses
 * and where its stops sit along it. Same content as GET /route-shape/:trainNo.
 */
exports.getBundle = async (req, res) => {
    const bundle = await load(req, res);
    if (!bundle) return;

    res.set('ETag', bundle.etag);
    // private: behind the API key, a shared cache must not replay it.
    res.set('Cache-Control', 'private, max-age=3600');
    res.set('Vary', 'Accept-Encoding');
    if (etagMatches(req.headers['if-none-match'], bundle.etag)) return res.status(304).end();

    const gz = acceptsGzip(req.headers['accept-encoding']);
    const body = gz ? bundle.gzip : bundle.json;
    res.set('Content-Type', 'application/json; charset=utf-8');
    if (gz) res.set('Content-Encoding', 'gzip');
    res.set('Content-Length', String(body.length));
    res.end(body);
};

/** GET /api/route-shapes/version?date= — the same check without the download. */
exports.getVersion = async (req, res) => {
    const bundle = await load(req, res);
    if (!bundle) return;

    res.set('ETag', bundle.etag);
    res.set('Cache-Control', 'private, max-age=60');
    if (etagMatches(req.headers['if-none-match'], bundle.etag)) return res.status(304).end();
    res.json({ version: bundle.version, serviceDate: bundle.serviceDate });
};
