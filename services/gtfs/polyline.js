'use strict';

/**
 * polyline.js — Google "encoded polyline" at a chosen precision. The route-shape
 * endpoint uses precision 6 (1e-6°, ~0.1 m), the same `polyline6` that Mapbox,
 * MapLibre and Apple MapKit helpers decode.
 */

function encodeValue(v, out) {
    let n = v < 0 ? ~(v << 1) : (v << 1);
    while (n >= 0x20) {
        out.push(String.fromCharCode((0x20 | (n & 0x1f)) + 63));
        n >>= 5;
    }
    out.push(String.fromCharCode(n + 63));
}

/** @param {{lat:number,lon:number}[]} points */
function encode(points, precision = 6) {
    const f = 10 ** precision;
    const out = [];
    let pLat = 0;
    let pLon = 0;
    for (const p of points) {
        const lat = Math.round(p.lat * f);
        const lon = Math.round(p.lon * f);
        encodeValue(lat - pLat, out);
        encodeValue(lon - pLon, out);
        pLat = lat;
        pLon = lon;
    }
    return out.join('');
}

/** Inverse of encode(); used by the tests and handy for debugging. */
function decode(str, precision = 6) {
    const f = 10 ** precision;
    const pts = [];
    let i = 0;
    let lat = 0;
    let lon = 0;
    const next = () => {
        let result = 0;
        let shift = 0;
        let b;
        do {
            b = str.charCodeAt(i++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
        } while (b >= 0x20);
        return (result & 1) ? ~(result >> 1) : (result >> 1);
    };
    while (i < str.length) {
        lat += next();
        lon += next();
        pts.push({ lat: lat / f, lon: lon / f });
    }
    return pts;
}

module.exports = { encode, decode };
