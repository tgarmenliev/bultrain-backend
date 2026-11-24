'use strict';

/**
 * operatorDisplay.js — how the passenger-facing name of a train operator is written.
 *
 * The operator of a trip is the feed's agency_id (trip.operator). This turns it into the object
 * every API response carries, always the same shape so a client has one thing to handle:
 *
 *     { id: 'IVKONI', name: 'Ивкони Експрес', nameEn: 'Ivkoni Express' }
 *
 * `name` is Bulgarian, `nameEn` English; the client picks by its own language (some endpoints
 * — the live map — do not know it). An operator we have no name for is still reported, by its id,
 * rather than being dropped or guessed at.
 */

const KNOWN = {
    BDZ:    { name: 'БДЖ',            nameEn: 'BDZ' },
    IVKONI: { name: 'Ивкони Експрес', nameEn: 'Ivkoni Express' },
};

/** @returns {{id:string,name:string,nameEn:string}|null}  null when the trip has no operator on record */
function describe(code) {
    if (!code) return null;
    const id = String(code);
    const k = KNOWN[id];
    return k ? { id, name: k.name, nameEn: k.nameEn } : { id, name: id, nameEn: id };
}

module.exports = { describe, KNOWN };
