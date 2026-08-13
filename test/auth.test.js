'use strict';

/**
 * Phase 2 — authors and roles.
 *   - scrypt password hashing round-trips and is salted;
 *   - verifyRole gates by role and treats legacy (role-less) tokens as admin;
 *   - the users store creates and finds accounts.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const jwt    = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Point the users store at a throwaway migrated DB BEFORE requiring it.
const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-auth-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const passwordHash = require('../services/auth/password');
const users        = require('../services/auth/users');
const verifyRole   = require('../middleware/verifyRole');

// ── password hashing ─────────────────────────────────────────────────────────

test('scrypt hashing verifies the right password and rejects the wrong one', () => {
    const { hash, salt } = passwordHash.hash('correct horse');
    assert.strictEqual(passwordHash.verify('correct horse', hash, salt), true);
    assert.strictEqual(passwordHash.verify('wrong', hash, salt), false);
    assert.strictEqual(passwordHash.verify('', hash, salt), false);
});

test('the same password hashes differently each time (random salt)', () => {
    const a = passwordHash.hash('same');
    const b = passwordHash.hash('same');
    assert.notStrictEqual(a.hash, b.hash);
    assert.notStrictEqual(a.salt, b.salt);
    // …but each still verifies against its own salt.
    assert.ok(passwordHash.verify('same', a.hash, a.salt));
    assert.ok(passwordHash.verify('same', b.hash, b.salt));
});

// ── verifyRole ───────────────────────────────────────────────────────────────

function run(mw, token) {
    const req = { cookies: token ? { admin_token: token } : {} };
    let status = 200; let body = null; let nexted = false;
    const res = { status(c) { status = c; return this; }, json(o) { body = o; return this; } };
    mw(req, res, () => { nexted = true; });
    return { status, body, nexted, req };
}
const sign = (payload) => jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });

test('verifyRole lets an allowed role through and blocks others', () => {
    const authorMw = verifyRole('admin', 'author');
    const adminMw  = verifyRole('admin');

    assert.strictEqual(run(authorMw, sign({ role: 'author', username: 'ana' })).nexted, true);
    assert.strictEqual(run(adminMw,  sign({ role: 'author', username: 'ana' })).status, 403, 'author blocked from admin-only');
    assert.strictEqual(run(adminMw,  sign({ role: 'admin' })).nexted, true);
});

test('a legacy token with no role counts as admin', () => {
    const adminMw = verifyRole('admin');
    const r = run(adminMw, sign({ username: 'legacy' })); // no role field
    assert.strictEqual(r.nexted, true);
    assert.strictEqual(r.req.admin.role, undefined, 'payload unchanged; role inferred, not mutated');
});

test('missing or invalid tokens are 401', () => {
    const mw = verifyRole('admin');
    assert.strictEqual(run(mw, null).status, 401);
    assert.strictEqual(run(mw, 'not-a-jwt').status, 401);
});

// ── users store ──────────────────────────────────────────────────────────────

test('users store creates and finds an account, defaulting to author', () => {
    const { hash, salt } = passwordHash.hash('pw-for-ana');
    const id = users.create({ username: 'ana', password_hash: hash, salt });
    assert.ok(id > 0);

    const found = users.findByUsername('ana');
    assert.strictEqual(found.role, 'author');
    assert.ok(passwordHash.verify('pw-for-ana', found.password_hash, found.salt));
    assert.strictEqual(users.findByUsername('nobody'), null);
});
