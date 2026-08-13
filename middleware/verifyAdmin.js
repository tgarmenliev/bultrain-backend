'use strict';

/**
 * verifyAdmin — the admin-only gate for /api/admin/* (except login/logout).
 *
 * Now a thin specialisation of verifyRole('admin') so the many routes that
 * already `require` it keep working unchanged, while an 'author' token (articles
 * only) is correctly refused from the train/schedule endpoints.
 */
module.exports = require('./verifyRole')('admin');
