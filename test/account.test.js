'use strict';

/**
 * Any signed-in account can change its own password. The rules that matter:
 * the current password must be right, the new one long enough and different,
 * the bootstrap admin (ADMIN_PASSWORD, no users row) is told plainly it cannot
 * be changed from the panel, and after a change the OLD password stops working
 * while the NEW one signs in — checked through the same verify() login uses.
 */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bultrain-account-')), 'test.sqlite');
process.env.BULTRAIN_DB = TMP;
require('../database/migrate')(TMP);

const passwordHash = require('../services/auth/password');
const users        = require('../services/auth/users');
const ctrl         = require('../controllers/accountController');

const mockRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; } });

function makeUser(username, password, role = 'author') {
    const { hash, salt } = passwordHash.hash(password);
    return users.create({ username, password_hash: hash, salt, role });
}

/** Whether `password` would sign this account in (the check login() performs). */
function canSignIn(username, password) {
    const u = users.findByUsername(username);
    return !!u && passwordHash.verify(password, u.password_hash, u.salt);
}

const asUser = (uid, username, role = 'author') => ({ admin: { uid, username, role } });

test('a correct change: old password stops working, new one signs in', () => {
    const uid = makeUser('ivan', 'old-password-1');
    const res = mockRes();
    ctrl.changePassword({ ...asUser(uid, 'ivan'), body: { oldPassword: 'old-password-1', newPassword: 'brand-new-pass-2' } }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(canSignIn('ivan', 'brand-new-pass-2'), true);
    assert.strictEqual(canSignIn('ivan', 'old-password-1'), false, 'the old password must be dead');
});

test('a wrong current password is refused and nothing changes', () => {
    const uid = makeUser('maria', 'right-password-1');
    const res = mockRes();
    ctrl.changePassword({ ...asUser(uid, 'maria'), body: { oldPassword: 'not-the-password', newPassword: 'another-good-one-2' } }, res);

    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'wrong-old-password');
    assert.strictEqual(canSignIn('maria', 'right-password-1'), true, 'still the original');
    assert.strictEqual(canSignIn('maria', 'another-good-one-2'), false);
});

test('a too-short, missing or non-string new password is a 400 and changes nothing', () => {
    const uid = makeUser('petar', 'petar-password-1');
    const call = (body) => { const r = mockRes(); ctrl.changePassword({ ...asUser(uid, 'petar'), body }, r); return r; };

    let r = call({ oldPassword: 'petar-password-1', newPassword: 'short' });
    assert.strictEqual(r.statusCode, 400);
    assert.strictEqual(r.body.code, 'too-short');

    r = call({ oldPassword: 'petar-password-1' });
    assert.strictEqual(r.body.code, 'invalid-input');

    r = call({ oldPassword: 'petar-password-1', newPassword: { $ne: 1 } });
    assert.strictEqual(r.body.code, 'invalid-input', 'an object must not be hashed as "[object Object]"');

    r = call(undefined);
    assert.strictEqual(r.statusCode, 400, 'no body at all');

    r = call({ oldPassword: 'petar-password-1', newPassword: 'x'.repeat(300) });
    assert.strictEqual(r.body.code, 'too-long');

    assert.strictEqual(canSignIn('petar', 'petar-password-1'), true);
});

test('the new password must differ from the current one', () => {
    const uid = makeUser('georgi', 'same-password-1');
    const res = mockRes();
    ctrl.changePassword({ ...asUser(uid, 'georgi'), body: { oldPassword: 'same-password-1', newPassword: 'same-password-1' } }, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'same-as-old');
});

test('the bootstrap admin (no users row) gets a clear 409, not a broken form', () => {
    const res = mockRes();
    ctrl.changePassword({ admin: { role: 'admin', username: 'admin' }, body: { oldPassword: 'x', newPassword: 'whatever-long-1' } }, res);
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'legacy-admin');
});

test('an account switched off after login can no longer change anything', () => {
    const uid = makeUser('gone', 'gone-password-1');
    const Database = require('better-sqlite3');
    const db = new Database(TMP); db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(uid); db.close();

    const res = mockRes();
    ctrl.changePassword({ ...asUser(uid, 'gone'), body: { oldPassword: 'gone-password-1', newPassword: 'a-new-password-3' } }, res);
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.code, 'account-not-found');
});

test("one account's change never touches another's password", () => {
    const a = makeUser('ana', 'ana-password-1');
    makeUser('boris', 'boris-password-1');
    const res = mockRes();
    ctrl.changePassword({ ...asUser(a, 'ana'), body: { oldPassword: 'ana-password-1', newPassword: 'ana-changed-pass-2' } }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(canSignIn('boris', 'boris-password-1'), true);
});

test('getAccount tells the panel whether a form can work', () => {
    let res = mockRes();
    ctrl.getAccount(asUser(7, 'ivan', 'author'), res);
    assert.deepStrictEqual(res.body, { username: 'ivan', role: 'author', canChangePassword: true });

    res = mockRes();
    ctrl.getAccount({ admin: { role: 'admin', username: 'admin' } }, res);
    assert.strictEqual(res.body.canChangePassword, false);
});
