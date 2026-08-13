'use strict';

/**
 * Media upload — the parts that decide safety and the response the editor saves.
 * The multipart plumbing is multer's; here we pin the type gate, the
 * server-generated filename (no client input reaches disk), and the payload.
 */

const test   = require('node:test');
const assert = require('node:assert');
const media  = require('../controllers/mediaController');

test('only real image types are accepted, mapped to a safe extension', () => {
    assert.strictEqual(media.extForMime('image/jpeg'), 'jpg');
    assert.strictEqual(media.extForMime('image/png'), 'png');
    assert.strictEqual(media.extForMime('image/webp'), 'webp');
    assert.strictEqual(media.extForMime('image/gif'), null, 'gif not allowed in v1');
    assert.strictEqual(media.extForMime('text/html'), null, 'no non-images');
    assert.strictEqual(media.extForMime('application/octet-stream'), null);
});

test('the filename is server-generated, unique, and free of path/spoof characters', () => {
    const a = media.makeFilename('image/jpeg');
    const b = media.makeFilename('image/jpeg');
    assert.match(a, /^art-\d+-[0-9a-f]{12}\.jpg$/, 'shape is fixed, extension from MIME');
    assert.notStrictEqual(a, b, 'two uploads never collide');
    assert.ok(!a.includes('/') && !a.includes('..'), 'no path traversal');
    assert.strictEqual(media.makeFilename('image/gif'), null, 'unsupported type → no name');
});

test('uploadMedia reports the stored filename and its URL', () => {
    const res = mockRes();
    media.uploadMedia({ file: { filename: 'art-123-abcdef012345.jpg' } }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.filename, 'art-123-abcdef012345.jpg');
    assert.strictEqual(res.body.url, '/guide/images/art-123-abcdef012345.jpg',
        'URL matches how the handbook already references images');
});

test('uploadMedia 400s when no file came through', () => {
    const res = mockRes();
    media.uploadMedia({}, res);
    assert.strictEqual(res.statusCode, 400);
});

function mockRes() {
    return {
        statusCode: 200,
        body: null,
        status(c) { this.statusCode = c; return this; },
        json(o) { this.body = o; return this; },
    };
}
