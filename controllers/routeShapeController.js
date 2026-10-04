'use strict';

const crypto     = require('crypto');
const routeShape = require('../services/gtfs/routeShape');
const adminView  = require('../services/gtfs/adminView');   // isValidYmd / sofiaToday only

const TRAIN_NO_RE = /^[0-9A-Za-z-]{1,16}$/;

const etagMatches = (header, etag) => !!header && header.split(',').some(t => {
    const v = t.trim();
    return v === '*' || v.replace(/^W\//, '') === etag;
});

/**
 * GET /api/route-shape/:trainNo?date=YYYY-MM-DD
 * Track geometry of a train on a day (date defaults to today, Sofia time).
 * 404 means "no shape for this train/date" — a normal answer: the client falls
 * back to straight lines between its stops.
 */
exports.getRouteShape = (req, res) => {
    const trainNo = req.params.trainNo;
    if (!TRAIN_NO_RE.test(trainNo)) return res.status(404).json({ error: 'No route shape for this train.' });

    let date = req.query.date;
    if (date === undefined) date = adminView.sofiaToday();
    else if (!adminView.isValidYmd(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD.' });

    let body;
    try {
        body = routeShape.forTrain(trainNo, date);
    } catch (err) {
        console.error('routeShapeController error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
    if (!body) return res.status(404).json({ error: 'No route shape for this train.' });

    const json = JSON.stringify(body);
    const etag = `"${crypto.createHash('sha1').update(json).digest('hex').slice(0, 16)}"`;
    res.set('ETag', etag);
    // The geometry only changes with the daily GTFS refresh. private: the
    // response sits behind the API key, a shared cache must not replay it.
    res.set('Cache-Control', 'private, max-age=3600');
    if (etagMatches(req.headers['if-none-match'], etag)) return res.status(304).end();
    res.type('application/json').send(json);
};
