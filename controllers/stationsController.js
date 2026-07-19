const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

// ── Database ────────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, '..', 'bultrain.sqlite');
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

const stmtAll = db.prepare('SELECT id, name, english_name, lat, lon FROM stations ORDER BY id');

// Build the station list plus a content version. The version is a hash of the
// data itself, so it changes if and only if a station's id/name/coord changes
// or a station is added/removed — which happens on deploy and on the daily GTFS
// refresh (reconcile-coords). The app compares versions and only re-downloads
// when something actually changed.
function build() {
    const stations = stmtAll.all().map(r => ({
        id: r.id,
        name: r.name,
        englishName: r.english_name,
        lat: r.lat,
        lon: r.lon,
    }));
    const version = crypto.createHash('sha256')
        .update(JSON.stringify(stations))
        .digest('hex')
        .slice(0, 16);
    return { version, stations };
}

/**
 * GET /api/stations
 * Full station list with coordinates and a content version. Supports
 * conditional requests: send If-None-Match with the last version to get 304
 * when nothing has changed.
 */
exports.getStations = (req, res) => {
    try {
        const { version, stations } = build();
        const etag = `"${version}"`;

        if (req.headers['if-none-match'] === etag) {
            return res.status(304).end();
        }

        res.set('ETag', etag);
        res.set('Cache-Control', 'no-cache'); // cache, but revalidate every time
        res.header('Content-Type', 'application/json');
        res.send(JSON.stringify({ version, count: stations.length, stations }, null, 4));
    } catch (error) {
        console.error('stationsController error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

/**
 * GET /api/stations/version
 * Just the current version — a cheap check the app can poll before deciding
 * whether to pull the full list.
 */
exports.getStationsVersion = (req, res) => {
    try {
        const { version } = build();
        res.json({ version });
    } catch (error) {
        console.error('stationsController version error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};
