import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidSaudiVat, encodeQR, decodeQR, checkCompliance, round2 } from '../src/zatca.js';

test('VAT number: 15 digits, starts and ends with 3 (BR-KSA-40)', () => {
  assert.equal(isValidSaudiVat('310122334400003'), true);
  assert.equal(isValidSaudiVat('300000000000003'), true);
  assert.equal(isValidSaudiVat('31012233440000'), false, '14 digits');
  assert.equal(isValidSaudiVat('3101223344000033'), false, '16 digits');
  assert.equal(isValidSaudiVat('110122334400003'), false, 'starts with 1 (CR number)');
  assert.equal(isValidSaudiVat('310122334400001'), false, 'ends with 1');
  assert.equal(isValidSaudiVat('3101223344A0003'), false, 'letter');
  assert.equal(isValidSaudiVat(undefined), false);
  assert.equal(isValidSaudiVat(310122334400003), false, 'number type rejected');
});

test('QR TLV round-trip, including multi-byte Arabic seller name', () => {
  const f = { sellerName: 'شركة النور للمستلزمات المكتبية', vatNumber: '310122334400003', timestamp: '2026-10-12T09:30:00', total: '5175.00', vatTotal: '675.00' };
  const b64 = encodeQR(f);
  assert.match(b64, /^[A-Za-z0-9+/]+=*$/);
  assert.deepEqual(decodeQR(b64), f);
});

test('QR TLV byte layout: tag, length in BYTES, value', () => {
  const bytes = Buffer.from(encodeQR({ sellerName: 'AB', vatNumber: '3', timestamp: 't', total: '1', vatTotal: '0' }), 'base64');
  assert.deepEqual([...bytes.subarray(0, 4)], [1, 2, 65, 66]);
  const ar = Buffer.from(encodeQR({ sellerName: 'ن', vatNumber: '3', timestamp: 't', total: '1', vatTotal: '0' }), 'base64');
  assert.equal(ar[1], 2, 'Arabic letter is 2 UTF-8 bytes, length must count bytes not characters');
});

test('decodeQR rejects truncated or incomplete payloads', () => {
  const good = Buffer.from(encodeQR({ sellerName: 'A', vatNumber: '3', timestamp: 't', total: '1', vatTotal: '0' }), 'base64');
  assert.throws(() => decodeQR(good.subarray(0, good.length - 1).toString('base64')), /Malformed/);
  assert.throws(() => decodeQR(Buffer.from([1, 1, 65]).toString('base64')), /missing field/);
});

const base = () => {
  const inv = { sellerName: 'X', sellerVat: '310122334400003', issueDate: '2026-10-12', lines: [{ qty: 10, unitPrice: 450 }], subtotal: 4500, vatAmount: 675, total: 5175 };
  inv.qr = encodeQR({ sellerName: 'X', vatNumber: inv.sellerVat, timestamp: '2026-10-12T09:00:00', total: '5175.00', vatTotal: '675.00' });
  return inv;
};

test('compliant invoice has no issues', () => {
  assert.deepEqual(checkCompliance(base()), []);
});

test('detects wrong VAT rate, wrong total, line/subtotal mismatch', () => {
  assert.equal(checkCompliance({ ...base(), vatAmount: 225, total: 4725, qr: undefined }).find((i) => i.code === 'VAT_CALC_ERROR').code, 'VAT_CALC_ERROR');
  assert.ok(checkCompliance({ ...base(), total: 5200 }).some((i) => i.code === 'VAT_CALC_ERROR'));
  assert.ok(checkCompliance({ ...base(), lines: [{ qty: 9, unitPrice: 450 }] }).some((i) => i.code === 'VAT_CALC_ERROR'));
});

test('rounding within 1 halala is accepted', () => {
  const inv = { ...base(), lines: [{ qty: 3, unitPrice: 33.33 }], subtotal: 99.99, vatAmount: 15, total: 114.99 };
  inv.qr = encodeQR({ sellerName: 'X', vatNumber: inv.sellerVat, timestamp: 't', total: '114.99', vatTotal: '15.00' });
  assert.deepEqual(checkCompliance(inv), []);
  assert.equal(round2(1.005), 1.01);
});

test('QR disagreeing with the invoice body is flagged as possible tampering', () => {
  const inv = base();
  inv.total = 5175; // body unchanged
  inv.qr = encodeQR({ sellerName: 'X', vatNumber: inv.sellerVat, timestamp: 't', total: '4175.00', vatTotal: '675.00' });
  assert.deepEqual(checkCompliance(inv).map((i) => i.code), ['QR_MISMATCH']);
  assert.deepEqual(checkCompliance({ ...base(), qr: '!!!' }).map((i) => i.code), ['QR_MISMATCH']);
  assert.deepEqual(checkCompliance({ ...base(), qr: undefined }).map((i) => i.code), ['QR_MISSING']);
});
