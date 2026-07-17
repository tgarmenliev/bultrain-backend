'use strict';

/**
 * config.js — Bulgarian National Access Point (NAP) endpoints for BDŽ.
 *
 * No API key is required. The static download id ROTATES on each republish
 * (currently daily), so static must always be resolved via the files list —
 * never hardcode a /files/{id}/download URL. Realtime is keyed by a stable
 * subset id and always returns the current feed.
 */

const BASE = 'https://sipbg.gov.bg/bgnap/portal/api/catalog';

module.exports = {
    BASE,

    // GTFS static: list files, take is_latest, download by its record id.
    STATIC_SUBSET: '28055fe4-d0da-4471-a1b9-13c434e6d5d9',
    filesUrl:    (subset) => `${BASE}/subsets/${subset}/files?format=gtfs-static`,
    downloadUrl: (fileId) => `${BASE}/files/${fileId}/download`,

    // GTFS realtime (Phase 2): stable per-subset URLs, ~15-20s fresh, protobuf.
    RT: {
        vehiclePositions: `${BASE}/subsets/cddd12ef-5ae8-46a6-9afc-faeaafbc552d/realtime-download`,
        tripUpdates:      `${BASE}/subsets/cc43fe99-141e-4eb8-bef1-cae144870a0f/realtime-download`,
        // SIRI VehicleMonitoring also exists (2eda5f5c-...) — we use GTFS-RT.
    },

    // Where downloaded feeds are archived (gitignored). Kept versioned so we
    // can diff feed-to-feed and roll back a bad import.
    ARCHIVE_DIR: require('path').join(__dirname, '..', '..', 'data', 'gtfs'),
    ARCHIVE_KEEP: 14,
};
