'use strict';

/**
 * create-user.js — create an admin-panel account (an author, or another admin).
 *
 *   node scripts/create-user.js <username> [author|admin]
 *
 * The password is read at a hidden prompt (on a terminal) or from stdin (when
 * piped) — never passed as an argument, so it stays out of the shell history and
 * the process list. Run it on the server, where the database lives.
 */

const readline = require('readline');
const passwordHash = require('../services/auth/password');
const users = require('../services/auth/users');

const username = process.argv[2];
const role = process.argv[3] || 'author';

if (!username || !['author', 'admin'].includes(role)) {
    console.error('Usage: node scripts/create-user.js <username> [author|admin]');
    process.exit(1);
}
if (users.findByUsername(username)) {
    console.error(`A user named "${username}" already exists.`);
    process.exit(1);
}

function readPassword() {
    return new Promise((resolve) => {
        // Piped / non-interactive: take the first line of stdin.
        if (!process.stdin.isTTY) {
            let data = '';
            process.stdin.setEncoding('utf8');
            process.stdin.on('data', (c) => { data += c; });
            process.stdin.on('end', () => resolve(data.split(/\r?\n/)[0] || ''));
            return;
        }
        // Interactive: prompt and mute the echo.
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        process.stdout.write('Password (min 8 chars): ');
        rl._writeToOutput = () => {};
        rl.question('', (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
    });
}

(async () => {
    const pw = await readPassword();
    if (!pw || pw.length < 8) {
        console.error('Password must be at least 8 characters — nothing created.');
        process.exit(1);
    }
    const { hash, salt } = passwordHash.hash(pw);
    const id = users.create({ username, password_hash: hash, salt, role });
    console.log(`Created ${role} account "${username}" (id ${id}).`);
    process.exit(0);
})();
