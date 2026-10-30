// ZATCA (Saudi Zakat, Tax and Customs Authority) e-invoicing compliance checks.
// Pure functions, zero dependencies; run identically in Node 18+ and the browser.
//
// Rules implemented (sources in docs/SOURCES.md):
//  - Standard VAT rate 15% (effective 1 July 2020).
//  - Seller VAT registration number: exactly 15 digits, first and last digit "3" (ZATCA rule BR-KSA-40).
//  - QR code: Base64 of TLV (Tag-Length-Value) bytes. Tags 1-5 = seller name, VAT number,
//    timestamp, invoice total incl. VAT, VAT total (Phase 1 minimum fields, still the first 5 tags in Phase 2).

export const VAT_RATE = 0.15;

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** ZATCA rule BR-KSA-40: a seller VAT number has 15 digits and starts and ends with 3. */
export function isValidSaudiVat(vat) {
  return typeof vat === 'string' && /^3\d{13}3$/.test(vat);
}

// ---------- base64 helpers (work in Node and browsers) ----------
function bytesToBase64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function base64ToBytes(b64) {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The five core TLV tags of the ZATCA QR code (Phase 1). */
export const QR_TAGS = { 1: 'sellerName', 2: 'vatNumber', 3: 'timestamp', 4: 'total', 5: 'vatTotal' };

/** Encode the 5 Phase-1 QR fields into ZATCA TLV Base64. Values are UTF-8 (Arabic names are multi-byte). */
export function encodeQR({ sellerName, vatNumber, timestamp, total, vatTotal }) {
  const enc = new TextEncoder();
  const values = [sellerName, vatNumber, timestamp, total, vatTotal].map((v) => String(v));
  const bytes = [];
  values.forEach((v, i) => {
    const b = enc.encode(v);
    if (b.length > 255) throw new Error(`QR tag ${i + 1} exceeds 255 bytes`);
    bytes.push(i + 1, b.length, ...b);
  });
  return bytesToBase64(Uint8Array.from(bytes));
}

/** Decode a ZATCA TLV Base64 QR payload. Throws on malformed input. */
export function decodeQR(b64) {
  const bytes = base64ToBytes(b64);
  const dec = new TextDecoder('utf-8', { fatal: true });
  const fields = {};
  let i = 0;
  while (i < bytes.length) {
    const tag = bytes[i];
    const len = bytes[i + 1];
    if (len === undefined || i + 2 + len > bytes.length) throw new Error('Malformed TLV: length overruns payload');
    const value = dec.decode(bytes.slice(i + 2, i + 2 + len));
    if (QR_TAGS[tag]) fields[QR_TAGS[tag]] = value;
    i += 2 + len;
  }
  for (const name of Object.values(QR_TAGS)) {
    if (fields[name] === undefined) throw new Error(`QR missing field: ${name}`);
  }
  return fields;
}

/**
 * Run all ZATCA checks on a normalized invoice.
 * Returns a list of issues: { code, severity, message }
 */
export function checkCompliance(inv, { tolerance = 0.01 } = {}) {
  const issues = [];
  const add = (code, message, messageAr, severity = 'error') => issues.push({ code, severity, message, messageAr });

  if (!isValidSaudiVat(inv.sellerVat)) {
    add('INVALID_VAT_NUMBER', `Seller VAT "${inv.sellerVat ?? '—'}" is not 15 digits starting and ending with 3 (BR-KSA-40).`,
      `الرقم الضريبي للمورد "${inv.sellerVat ?? '—'}" ليس ١٥ رقماً يبدأ وينتهي بالرقم ٣ (القاعدة BR-KSA-40).`);
  }

  // Arithmetic: lines -> subtotal -> VAT -> total
  const lineSum = round2((inv.lines || []).reduce((s, l) => s + l.qty * l.unitPrice, 0));
  const expectedVat = round2(inv.subtotal * VAT_RATE);
  if (Math.abs(lineSum - inv.subtotal) > tolerance) {
    add('VAT_CALC_ERROR', `Line items sum to ${lineSum.toFixed(2)} but subtotal says ${Number(inv.subtotal).toFixed(2)}.`,
      `مجموع البنود ${lineSum.toFixed(2)} بينما المجموع المذكور ${Number(inv.subtotal).toFixed(2)}.`);
  } else if (Math.abs(expectedVat - inv.vatAmount) > tolerance) {
    add('VAT_CALC_ERROR', `VAT should be 15% × ${Number(inv.subtotal).toFixed(2)} = ${expectedVat.toFixed(2)}, invoice shows ${Number(inv.vatAmount).toFixed(2)}.`,
      `يجب أن تكون الضريبة ١٥٪ × ${Number(inv.subtotal).toFixed(2)} = ${expectedVat.toFixed(2)}، والفاتورة تذكر ${Number(inv.vatAmount).toFixed(2)}.`);
  } else if (Math.abs(round2(inv.subtotal + inv.vatAmount) - inv.total) > tolerance) {
    add('VAT_CALC_ERROR', `Subtotal + VAT = ${round2(inv.subtotal + inv.vatAmount).toFixed(2)} but total says ${Number(inv.total).toFixed(2)}.`,
      `المجموع + الضريبة = ${round2(inv.subtotal + inv.vatAmount).toFixed(2)} بينما الإجمالي المذكور ${Number(inv.total).toFixed(2)}.`);
  }

  // QR cross-check: the QR is what ZATCA/auditors scan, the body is what people read.
  if (!inv.qr) {
    add('QR_MISSING', 'No ZATCA QR code found on the invoice.', 'لا يوجد رمز QR الخاص بهيئة الزكاة والضريبة والجمارك على الفاتورة.');
  } else {
    try {
      const q = decodeQR(inv.qr);
      const mismatches = [], mismatchesAr = [];
      if (q.vatNumber !== inv.sellerVat) { mismatches.push(`VAT number (QR ${q.vatNumber})`); mismatchesAr.push(`الرقم الضريبي (في الرمز ${q.vatNumber})`); }
      if (Math.abs(Number(q.total) - inv.total) > tolerance) { mismatches.push(`total (QR ${q.total})`); mismatchesAr.push(`الإجمالي (في الرمز ${q.total})`); }
      if (Math.abs(Number(q.vatTotal) - inv.vatAmount) > tolerance) { mismatches.push(`VAT (QR ${q.vatTotal})`); mismatchesAr.push(`الضريبة (في الرمز ${q.vatTotal})`); }
      if (mismatches.length) add('QR_MISMATCH', `QR code disagrees with the invoice body on ${mismatches.join(', ')} — possible tampering.`,
        `رمز QR لا يطابق بيانات الفاتورة المطبوعة: ${mismatchesAr.join('، ')} — احتمال تلاعب.`);
    } catch (e) {
      add('QR_MISMATCH', `QR code could not be decoded: ${e.message}.`, 'تعذّر قراءة رمز QR.');
    }
  }
  return issues;
}
