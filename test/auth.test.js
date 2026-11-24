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

// ── the session: weeks long, and it ends when the account does ───────────────

const session = require('../services/auth/session');

function runRes(mw, token) {
    const req = { cookies: token ? { admin_token: token } : {} };
    const out = { status: 200, body: null, nexted: false, cookie: null };
    const res = {
        status(c) { out.status = c; return this; },
        json(o) { out.body = o; return this; },
        cookie(name, value, opts) { out.cookie = { name, value, opts }; },
    };
    mw(req, res, () => { out.nexted = true; });
    out.req = req;
    return out;
}

function makeUser(name, role = 'admin', password = 'first password') {
    const { hash, salt } = passwordHash.hash(password);
    const id = users.create({ username: name, password_hash: hash, salt, role });
    return users.findById(id);
}
const tokenFor = (user, extra = {}, expiresIn = '30d') =>
    jwt.sign({ ...session.payloadForUser(user), ...extra }, process.env.JWT_SECRET, { expiresIn });

test('a login lasts a month by default, and can be set', () => {
    assert.strictEqual(session.sessionDays(), 30);
    process.env.ADMIN_SESSION_DAYS = '7';
    assert.strictEqual(session.sessionDays(), 7);
    process.env.ADMIN_SESSION_DAYS = 'nonsense';
    assert.strictEqual(session.sessionDays(), 30);
    delete process.env.ADMIN_SESSION_DAYS;

    let cookie;
    session.issue({ cookie: (n, v, o) => { cookie = { n, v, o }; } }, { role: 'admin', username: 'x' });
    assert.strictEqual(cookie.o.maxAge, 30 * 24 * 60 * 60 * 1000);
    assert.strictEqual(cookie.o.httpOnly, true);
    assert.strictEqual(cookie.o.sameSite, 'strict');
    const decoded = jwt.verify(cookie.v, process.env.JWT_SECRET);
    assert.ok(decoded.exp - decoded.iat === 30 * 24 * 60 * 60);
});

test('a session in use renews itself once it is a day old, not before', () => {
    const user = makeUser('renewer');
    const day = 24 * 60 * 60;
    const now = Math.floor(Date.now() / 1000);

    const fresh = runRes(verifyRole('admin'), tokenFor(user, { iat: now - 3600 }));
    assert.ok(fresh.nexted);
    assert.strictEqual(fresh.cookie, null, 'an hour old: left alone');

    const old = runRes(verifyRole('admin'), tokenFor(user, { iat: now - day - 60 }));
    assert.ok(old.nexted);
    assert.ok(old.cookie, 'over a day old: replaced');
    const renewed = jwt.verify(old.cookie.value, process.env.JWT_SECRET);
    assert.strictEqual(renewed.uid, user.id);
    assert.strictEqual(renewed.pv, session.passwordFingerprint(user.password_hash), 'still bound to the same password');
    assert.ok(renewed.iat >= now);
    assert.strictEqual(renewed.exp - renewed.iat, 30 * day);
});

test('a changed password ends the old sessions', () => {
    const user = makeUser('rotator');
    const oldToken = tokenFor(user);
    assert.ok(runRes(verifyRole('admin'), oldToken).nexted);

    const { hash, salt } = passwordHash.hash('a different password');
    users.updatePassword(user.id, hash, salt);

    const after = runRes(verifyRole('admin'), oldToken);
    assert.strictEqual(after.nexted, false);
    assert.strictEqual(after.status, 401);
    assert.match(after.body.error, /password was changed/);

    assert.ok(runRes(verifyRole('admin'), tokenFor(users.findById(user.id))).nexted, 'a session under the new one works');
});

test('a disabled account is out at once, whatever its token says', () => {
    const user = makeUser('leaver', 'author');
    const token = tokenFor(user);
    assert.ok(runRes(verifyRole('admin', 'author'), token).nexted);

    const Database = require('better-sqlite3');
    const db = new Database(TMP); db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(user.id); db.close();

    const after = runRes(verifyRole('admin', 'author'), token);
    assert.strictEqual(after.status, 401);
    assert.match(after.body.error, /no longer active/);
});

test('the role is the account\'s CURRENT one, not the one at login', () => {
    const user = makeUser('demoted', 'admin');
    const token = tokenFor(user);
    assert.ok(runRes(verifyRole('admin'), token).nexted);

    const Database = require('better-sqlite3');
    const db = new Database(TMP); db.prepare("UPDATE users SET role = 'author' WHERE id = ?").run(user.id); db.close();

    assert.strictEqual(runRes(verifyRole('admin'), token).status, 403, 'demotion takes effect at once');
});

test('a token from before the fingerprint existed still works until it expires', () => {
    const user = makeUser('oldtoken');
    const token = jwt.sign({ role: user.role, username: user.username, uid: user.id }, process.env.JWT_SECRET, { expiresIn: '8h' });
    assert.ok(runRes(verifyRole('admin'), token).nexted);
});

test('the legacy ADMIN_PASSWORD session has no account to check and keeps working', () => {
    const token = jwt.sign({ role: 'admin', username: 'admin' }, process.env.JWT_SECRET, { expiresIn: '30d' });
    assert.ok(runRes(verifyRole('admin'), token).nexted);
});

test('changing the password keeps THIS session alive under the new one', () => {
    const accountController = require('../controllers/accountController');
    const user = makeUser('changer', 'admin', 'old password 1');
    const req = { admin: { uid: user.id }, body: { oldPassword: 'old password 1', newPassword: 'new password 22' } };
    const out = { cookie: null, body: null, status: 200 };
    const res = {
        status(c) { out.status = c; return this; },
        json(o) { out.body = o; return this; },
        cookie(n, v, o) { out.cookie = { n, v, o }; },
    };
    accountController.changePassword(req, res);
    assert.strictEqual(out.status, 200, JSON.stringify(out.body));

    const fresh = jwt.verify(out.cookie.v, process.env.JWT_SECRET);
    assert.strictEqual(fresh.pv, session.passwordFingerprint(users.findById(user.id).password_hash));
    assert.ok(runRes(verifyRole('admin'), out.cookie.v).nexted, 'the new cookie is accepted');
});
