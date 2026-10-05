'use strict';

/**
 * httpCache.js — the two conditional-request checks every cached endpoint needs.
 */

/** Does an If-None-Match header match `etag`? Handles lists, `*` and weak (W/) tags. */
const etagMatches = (header, etag) => !!header && String(header).split(',').some(t => {
    const v = t.trim();
    return v === '*' || v.replace(/^W\//, '') === etag;
});

/** Does an Accept-Encoding header allow gzip (and not `gzip;q=0`)? */
const acceptsGzip = (header) => String(header || '').split(',').some(part => {
    const [coding, ...params] = part.trim().split(';').map(s => s.trim());
    if (coding !== 'gzip' && coding !== '*') return false;
    const q = params.find(p => p.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
});

module.exports = { etagMatches, acceptsGzip };
