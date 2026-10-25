'use strict';

/**
 * sofia.js — wall-clock time in Bulgaria <-> instants, correct on the two days a year the
 * clock changes.
 *
 * A timetable says "11:09": a time on the WALL CLOCK of that day. "Midnight + 669 minutes" is
 * not that instant on a day that has 25 hours (the clocks go back, the last Sunday of October)
 * or 23 (they go forward, the last Sunday of March): after the change it is an hour off. On
 * 2026-10-25 every board that did that showed each train an hour early. So wall time is turned
 * into an instant through the time-zone rules, never by adding minutes to midnight.
 */

const ZONE = 'Europe/Sofia';

/** Offset of Sofia from UTC at an instant, in ms (+2 h in winter, +3 h in summer). */
function offsetMs(instantMs) {
    const whole = Math.floor(instantMs / 1000) * 1000;
    const wall = new Date(whole).toLocaleString('sv-SE', { timeZone: ZONE });   // "2026-10-25 11:09:00"
    return Date.parse(`${wall.replace(' ', 'T')}Z`) - whole;
}

/**
 * The instant at which Sofia's wall clock reads `minutes` minutes after 00:00 of `ymd`.
 * `minutes` may be 1440 or more (a trip that runs past midnight): the wall clock of the NEXT
 * day. In the one repeated hour of the autumn change the first (summer-time) reading wins.
 *
 * @param {string} ymd      YYYY-MM-DD
 * @param {number} minutes  wall-clock minutes after midnight of that day
 * @returns {number} epoch ms
 */
function wallToInstant(ymd, minutes) {
    const asIfUtc = Date.parse(`${ymd}T00:00:00Z`) + minutes * 60000;     // the wall reading, as a UTC number
    // The offset depends on the instant, and the instant on the offset: two passes settle it.
    let t = asIfUtc - offsetMs(asIfUtc - 3 * 3600000);
    t = asIfUtc - offsetMs(t);
    return t;
}

/** Epoch ms of 00:00 Sofia wall time on `ymd`. */
const midnightOf = (ymd) => wallToInstant(ymd, 0);

module.exports = { wallToInstant, midnightOf, offsetMs, ZONE };
