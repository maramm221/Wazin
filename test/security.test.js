import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt, newKey, loadKey, hashPassword, verifyPassword, passwordProblem } from '../server/crypto.js';
import { parseCSV, csvCell } from '../server/csv.js';

const key = loadKey(newKey());

test('AES-256-GCM round trip, with a fresh IV every time', () => {
  const a = encrypt(key, 'SA4410000001234567890123', 'org1:iban');
  const b = encrypt(key, 'SA4410000001234567890123', 'org1:iban');
  assert.notEqual(a, b);
  assert.equal(decrypt(key, a, 'org1:iban'), 'SA4410000001234567890123');
  assert.equal(decrypt(key, encrypt(key, 'رقم عربي', 'x'), 'x'), 'رقم عربي');
});

test('ciphertext moved to another organisation or field fails to decrypt', () => {
  const c = encrypt(key, 'secret', 'org1:iban');
  assert.throws(() => decrypt(key, c, 'org2:iban'));
  assert.throws(() => decrypt(key, c, 'org1:phone'));
});

test('tampered ciphertext or a wrong key fails to decrypt', () => {
  const c = encrypt(key, 'secret', 'a');
  const raw = Buffer.from(c.slice(3), 'base64');
  raw[raw.length - 1] ^= 1;
  assert.throws(() => decrypt(key, `v1:${raw.toString('base64')}`, 'a'));
  assert.throws(() => decrypt(loadKey(newKey()), c, 'a'));
});

test('key must be exactly 32 bytes', () => {
  assert.throws(() => loadKey(''), /not set/);
  assert.throws(() => loadKey(Buffer.alloc(16).toString('base64')), /32 bytes/);
});

test('passwords are salted scrypt hashes', () => {
  const h1 = hashPassword('correct horse 42');
  assert.match(h1, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(h1, hashPassword('correct horse 42'));
  assert.equal(verifyPassword('correct horse 42', h1), true);
  assert.equal(verifyPassword('correct horse 43', h1), false);
  assert.equal(verifyPassword('x', 'garbage'), false);
});

test('password policy', () => {
  assert.equal(passwordProblem('short1'), 'password_too_short');
  assert.equal(passwordProblem('onlyletters'), 'password_needs_letter_and_digit');
  assert.equal(passwordProblem('a'.repeat(201) + '1'), 'password_too_long');
  assert.equal(passwordProblem('good password 1'), null);
});

test('CSV: quotes, commas, CRLF, BOM, Arabic', () => {
  const rows = parseCSV('﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n2,عربي,\r\n\r\n');
  assert.deepEqual(rows, [{ a: '1', b: 'x, y', c: 'say "hi"' }, { a: '2', b: 'عربي', c: '' }]);
});

test('CSV export neutralises spreadsheet formulas', () => {
  assert.equal(csvCell('=HYPERLINK("evil")'), `"'=HYPERLINK(""evil"")"`);
  assert.equal(csvCell('+966 11'), "'+966 11");
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell(null), '');
});
