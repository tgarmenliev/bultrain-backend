'use strict';

/**
 * vehicleFields.js — the per-vehicle fields we pass through from a GTFS-RT
 * VehiclePosition, and nothing we make up.
 *
 * protobufjs gives every ABSENT optional field its default on the prototype
 * (0 for a timestamp, the FIRST enum value — INCOMING_AT — for current_status),
 * so reading `v.currentStatus` directly would turn "the feed said nothing" into
 * a confident "INCOMING_AT". Only an own property was actually on the wire.
 */

const B = require('gtfs-realtime-bindings');

const STOP_STATUS = B.transit_realtime.VehiclePosition.VehicleStopStatus;

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * @returns {{positionTimestamp:number|null, stopStatus:string|null}}
 *   positionTimestamp — epoch ms of THIS vehicle's fix, exactly as the feed
 *   stamped it; null when the entity carries none. Never the poll time and never
 *   the feed header time.
 */
function fromEntity(v) {
    let positionTimestamp = null;
    if (v && has(v, 'timestamp') && v.timestamp != null) {
        const sec = Number(v.timestamp);
        if (Number.isFinite(sec) && sec > 0) positionTimestamp = sec * 1000;
    }

    let stopStatus = null;
    if (v && has(v, 'currentStatus') && v.currentStatus != null) {
        stopStatus = STOP_STATUS[v.currentStatus] || null;   // enum number → name
    }

    return { positionTimestamp, stopStatus };
}

module.exports = { fromEntity };
