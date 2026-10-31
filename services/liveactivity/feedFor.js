'use strict';

/**
 * feedFor.js — where the Live Activity pipelines read the realtime picture of a train from.
 *
 * A reserved TEST-prefixed number resolves synthetic data (see testFeed.js); every real number
 * falls straight through. The run is chosen per JOURNEY, not per number (see runMatch.js).
 */

const cache    = require('../realtime/cache');
const testFeed = require('./testFeed');
const { matchRun } = require('./runMatch');

const getTrain   = (num) => testFeed.getTrain(num) ?? cache.getTrain(num);
const getRunFor  = (row) => testFeed.getTrain(row.train_number) ?? matchRun(cache.getTrips(row.train_number), row);
const getVehicle = (num) => testFeed.getVehicle(num) ?? cache.getVehicle(num);

module.exports = { getTrain, getRunFor, getVehicle };
