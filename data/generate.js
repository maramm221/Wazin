// Labelled synthetic benchmark: realistic Saudi supplier invoices with known, injected defects.
// Deterministic (seeded) so every score in the README is reproducible.

import { encodeQR, round2, VAT_RATE } from '../src/zatca.js';

export function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BUYER = { nameEn: 'Sahara Retail Co.', nameAr: 'شركة صحارى للتجزئة', vat: '300999888700003' };

export const VENDORS = [
  { vat: '310122334400003', nameEn: 'Al-Noor Office Supplies', nameAr: 'شركة النور للمستلزمات المكتبية', iban: 'SA4410000001234567890123', phone: '+966 11 000 1001', email: 'billing@alnoor.example', paymentTermsDays: 30, earlyPayDiscount: { pct: 2, days: 10 },
    items: [['OFF-CHR', 'Ergonomic office chair', 'كرسي مكتب', 450], ['OFF-DSK', 'Standing desk', 'مكتب قائم', 1200], ['OFF-PPR', 'A4 paper (box of 5 reams)', 'ورق A4', 95], ['OFF-TNR', 'Printer toner cartridge', 'حبر طابعة', 310]] },
  { vat: '300456789000003', nameEn: 'Riyadh Tech Distribution', nameAr: 'الرياض لتوزيع التقنية', iban: 'SA1980000204608016212345', phone: '+966 11 000 2002', email: 'ar@riyadhtech.example', paymentTermsDays: 45,
    items: [['TEC-LAP', 'Business laptop 14"', 'حاسب محمول', 4200], ['TEC-MON', '27" monitor', 'شاشة ٢٧ بوصة', 890], ['TEC-DCK', 'USB-C docking station', 'منصة توصيل', 640], ['TEC-HDS', 'Noise-cancelling headset', 'سماعة رأس', 520]] },
  { vat: '302233445500003', nameEn: 'Jeddah Industrial Parts', nameAr: 'جدة للقطع الصناعية', iban: 'SA6545000000123456789012', phone: '+966 12 000 3003', email: 'finance@jip.example', paymentTermsDays: 60,
    items: [['IND-BRG', 'Ball bearing 6205', 'محمل كروي', 38], ['IND-PMP', 'Centrifugal pump', 'مضخة طرد مركزي', 5600], ['IND-VLV', 'Gate valve 4"', 'صمام بوابة', 780], ['IND-BLT', 'V-belt B52', 'سير نقل', 64]] },
  { vat: '311987654300003', nameEn: 'Dammam Logistics Co.', nameAr: 'شركة الدمام للخدمات اللوجستية', iban: 'SA2705000068201234567000', phone: '+966 13 000 4004', email: 'invoices@dammamlog.example', paymentTermsDays: 30,
    items: [['LOG-PAL', 'Pallet delivery Riyadh–Dammam', 'نقل منصة', 260], ['LOG-CNT', '20ft container haulage', 'نقل حاوية', 2900], ['LOG-STR', 'Warehouse storage (pallet-week)', 'تخزين', 45]] },
  { vat: '300765432100003', nameEn: 'Najd Catering Services', nameAr: 'نجد لخدمات الإعاشة', iban: 'SA0315000999876543210000', phone: '+966 11 000 5005', email: 'accounts@najdcatering.example', paymentTermsDays: 30, earlyPayDiscount: { pct: 1.5, days: 7 },
    items: [['CAT-LUN', 'Staff lunch (per person)', 'غداء موظف', 42], ['CAT-COF', 'Coffee break service', 'خدمة استراحة قهوة', 18], ['CAT-EVT', 'Event catering package', 'باقة إعاشة فعالية', 3500]] },
  { vat: '301112223300003', nameEn: 'Hejaz Cleaning & Facilities', nameAr: 'الحجاز للنظافة والمرافق', iban: 'SA5530400108012345670011', phone: '+966 12 000 6006', email: 'billing@hejazfm.example', paymentTermsDays: 30,
    items: [['FAC-CLN', 'Office cleaning (monthly)', 'تنظيف مكاتب شهري', 6800], ['FAC-AC', 'AC maintenance visit', 'صيانة تكييف', 350], ['FAC-PST', 'Pest control treatment', 'مكافحة حشرات', 900]] },
];

export const DEFECTS = ['clean', 'over_limit', 'invalid_vat', 'vat_math', 'qr_tamper', 'price_mismatch', 'qty_mismatch', 'missing_grn', 'duplicate', 'iban_change', 'no_po'];

export const EXPECTED = {
  clean: { decision: 'APPROVED_AUTO', codes: [] },
  over_limit: { decision: 'APPROVAL_REQUIRED', codes: [] },
  invalid_vat: { decision: 'EXCEPTION', codes: ['INVALID_VAT_NUMBER'] },
  vat_math: { decision: 'EXCEPTION', codes: ['VAT_CALC_ERROR'] },
  qr_tamper: { decision: 'EXCEPTION', codes: ['QR_MISMATCH'] },
  price_mismatch: { decision: 'EXCEPTION', codes: ['PRICE_VARIANCE'] },
  qty_mismatch: { decision: 'EXCEPTION', codes: ['QTY_VARIANCE'] },
  missing_grn: { decision: 'PARKED', codes: ['AWAITING_GRN'] },
  duplicate: { decision: 'BLOCKED', codes: ['DUPLICATE'] },
  iban_change: { decision: 'BLOCKED', codes: ['BANK_DETAILS_CHANGED'] },
  no_po: { decision: 'EXCEPTION', codes: ['PO_NOT_FOUND'] },
};

// ---------------- Renderers ----------------
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const f2 = (n) => Number(n).toFixed(2);
const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toArabicDigits = (s) => String(s).replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]).replace(/\./g, '٫');

export function renderUBL(inv) {
  const lines = inv.lines.map((l, i) => `  <cac:InvoiceLine>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">${l.qty}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="SAR">${f2(l.qty * l.unitPrice)}</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>${xmlEsc(l.name)}</cbc:Name>
      <cac:SellersItemIdentification><cbc:ID>${l.sku}</cbc:ID></cac:SellersItemIdentification>
      <cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>15.00</cbc:Percent></cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="SAR">${f2(l.unitPrice)}</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${inv.invoiceNumber}</cbc:ID>
  <cbc:UUID>${inv.uuid}</cbc:UUID>
  <cbc:IssueDate>${inv.issueDate}</cbc:IssueDate>
  <cbc:IssueTime>${inv.issueTime}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="0100000">388</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
  <cac:OrderReference><cbc:ID>${inv.poNumber}</cbc:ID></cac:OrderReference>
  <cac:AdditionalDocumentReference>
    <cbc:ID>QR</cbc:ID>
    <cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${inv.qr}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment>
  </cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PartyTaxScheme><cbc:CompanyID>${inv.sellerVat}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
    <cac:PartyLegalEntity><cbc:RegistrationName>${xmlEsc(inv.sellerName)}</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party>
    <cac:PartyTaxScheme><cbc:CompanyID>${BUYER.vat}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
    <cac:PartyLegalEntity><cbc:RegistrationName>${xmlEsc(BUYER.nameEn)}</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingCustomerParty>
  <cac:PaymentMeans><cbc:PaymentMeansCode>42</cbc:PaymentMeansCode><cac:PayeeFinancialAccount><cbc:ID>${inv.iban}</cbc:ID></cac:PayeeFinancialAccount></cac:PaymentMeans>
  <cac:TaxTotal><cbc:TaxAmount currencyID="SAR">${f2(inv.vatAmount)}</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="SAR">${f2(inv.subtotal)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="SAR">${f2(inv.subtotal)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="SAR">${f2(inv.total)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="SAR">${f2(inv.total)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${lines}
</Invoice>`;
}

export function renderText(inv, vendor) {
  return `TAX INVOICE / فاتورة ضريبية
Invoice No / رقم الفاتورة: ${inv.invoiceNumber}
Date / التاريخ: ${inv.issueDate} ${inv.issueTime.slice(0, 5)}
Seller / المورد: ${inv.sellerName} | ${vendor.nameAr}
Seller VAT / الرقم الضريبي: ${inv.sellerVat}
Buyer / العميل: ${BUYER.nameEn}
PO / أمر الشراء: ${inv.poNumber}
IBAN: ${inv.iban}
Items / البنود:
${inv.lines.map((l) => `- ${l.sku} | ${l.name} | ${l.qty} x ${f2(l.unitPrice)}`).join('\n')}
Subtotal / المجموع: ${fmt(inv.subtotal)}
VAT 15% / ضريبة القيمة المضافة: ${fmt(inv.vatAmount)}
Total / الإجمالي: ${fmt(inv.total)} SAR
QR: ${inv.qr}`;
}

export function renderArabic(inv, vendor) {
  const A = toArabicDigits;
  return `فاتورة ضريبية
رقم الفاتورة: ${inv.invoiceNumber}
تاريخ الفاتورة: ${A(inv.issueDate)}
المورد: ${vendor.nameAr}
الرقم الضريبي: ${A(inv.sellerVat)}
رقم أمر الشراء: ${inv.poNumber}
الآيبان: ${inv.iban}
البنود:
${inv.lines.map((l) => `- ${l.sku} | ${l.nameAr || l.name} | ${A(l.qty)} × ${A(f2(l.unitPrice))}`).join('\n')}
الإجمالي قبل الضريبة: ${A(f2(inv.subtotal))}
ضريبة القيمة المضافة: ${A(f2(inv.vatAmount))}
الإجمالي شامل الضريبة: ${A(f2(inv.total))} ر.س
QR: ${inv.qr}`;
}

export function renderEmail(inv) {
  const items = inv.lines.map((l) => `${l.qty} × ${l.name} (${l.sku}) at ${fmt(l.unitPrice)} each`).join(', ');
  return `Subject: invoice for your order

Hello Sahara team,

Hope you are well. Please find below our invoice ${inv.invoiceNumber} dated ${inv.issueDate} against your purchase order ${inv.poNumber}.
We delivered ${items}.
That comes to ${fmt(inv.subtotal)} before tax, plus ${fmt(inv.vatAmount)} VAT, so ${fmt(inv.total)} SAR in total.
For your records our VAT registration is ${inv.sellerVat} and payment goes to ${inv.iban}.
QR payload ${inv.qr}

Best regards,
${inv.sellerName}`;
}

// ---------------- Scenario builder ----------------
// Defects that can co-occur on one invoice (stress test: "multiple issues at once").
export const COMBINABLE = ['invalid_vat', 'vat_math', 'qr_tamper', 'price_mismatch', 'iban_change'];

/** Expected outcome for one or more defects, following Wazin's documented priority policy. */
export function expectedFor(defs) {
  if (defs.length === 1) return EXPECTED[defs[0]];
  const codes = [...new Set(defs.flatMap((d) => EXPECTED[d].codes))];
  return { decision: defs.includes('iban_change') ? 'BLOCKED' : 'EXCEPTION', codes };
}

export function buildScenario({ seed = 2026, n = 300, emailShare = 0.1, approvalLimit = 50000, compoundShare = 0, vendors = VENDORS, weights: customWeights } = {}) {
  const rnd = mulberry32(seed);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const purchaseOrders = [];
  const goodsReceipts = [];
  const lateGRNs = [];
  const invoices = [];
  const approvedClean = [];
  let poSeq = 1000, grnSeq = 5000;
  const weights = customWeights || { clean: 40, over_limit: 5, invalid_vat: 6, vat_math: 6, qr_tamper: 5, price_mismatch: 7, qty_mismatch: 6, missing_grn: 6, duplicate: 6, iban_change: 5, no_po: 4 };
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  const drawDefect = () => {
    let r = rnd() * total;
    for (const [k, w] of Object.entries(weights)) if ((r -= w) < 0) return k;
    return 'clean';
  };

  for (let i = 0; i < n; i++) {
    let defect = drawDefect();
    if (defect === 'duplicate' && approvedClean.length === 0) defect = 'clean';
    const defs = [defect];
    if (compoundShare && rnd() < compoundShare && (defect === 'clean' || COMBINABLE.includes(defect))) {
      const pool = COMBINABLE.filter((d) => !defs.includes(d));
      if (defect === 'clean') defs[0] = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
      const more = rnd() < 0.4 ? 2 : 1; // two or three simultaneous defects
      for (let k = 0; k < more; k++) {
        const rest = COMBINABLE.filter((d) => !defs.includes(d));
        defs.push(rest[Math.floor(rnd() * rest.length)]);
      }
    }
    const has = (d) => defs.includes(d);
    const format = rnd() < emailShare ? 'email' : rnd() < 0.55 ? 'ubl' : rnd() < 0.7 ? 'text' : 'arabic';

    if (defect === 'duplicate') {
      const orig = pick(approvedClean);
      const inv = { ...orig.inv, uuid: `dup-${i}` };
      if (rnd() < 0.5) inv.invoiceNumber = `${orig.inv.invoiceNumber}-R`; // re-numbered resubmission
      invoices.push(makeEntry(i, inv, orig.vendor, format, 'duplicate'));
      continue;
    }

    const vendor = pick(vendors);
    const nLines = int(1, 3);
    const chosen = [...vendor.items].sort(() => rnd() - 0.5).slice(0, nLines);
    const scale = has('over_limit') ? 6 : 1;
    let lines = chosen.map(([sku, name, nameAr, price]) => ({ sku, name, nameAr, unitPrice: price, qty: Math.max(1, Math.round(int(1, Math.max(2, Math.floor(9000 / price))) * scale)) }));
    // keep clean invoices under the approval limit; push over_limit above it
    const sub = () => round2(lines.reduce((s, l) => s + l.qty * l.unitPrice, 0));
    while (!has('over_limit') && sub() * (1 + VAT_RATE) > approvalLimit * 0.9) lines = lines.map((l) => ({ ...l, qty: Math.max(1, Math.floor(l.qty / 2)) }));
    while (has('over_limit') && sub() * (1 + VAT_RATE) <= approvalLimit) lines = lines.map((l) => ({ ...l, qty: l.qty * 2 }));

    const poNumber = `PO-2026-${++poSeq}`;
    const po = { poNumber, vendorVat: vendor.vat, buyer: pick(['sara.alqahtani@sahara.example', 'omar.alharbi@sahara.example', 'noura.alotaibi@sahara.example']), lines: lines.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty, unitPrice: l.unitPrice })) };
    purchaseOrders.push(po);
    const grn = { grnNumber: `GRN-${++grnSeq}`, poNumber, lines: lines.map((l) => ({ sku: l.sku, qty: l.qty })) };
    if (has('qty_mismatch')) {
      // warehouse received fewer units than the supplier billed
      const k = int(0, grn.lines.length - 1);
      if (lines[k].qty < 2) { lines[k].qty = 2; po.lines[k].qty = 2; }
      grn.lines[k].qty = Math.max(1, lines[k].qty - Math.max(1, Math.ceil(lines[k].qty * 0.3)));
    }
    if (has('missing_grn')) lateGRNs.push(grn);
    else goodsReceipts.push(grn);

    const day = int(1, 28);
    const inv = {
      invoiceNumber: `${vendor.nameEn.split(/[\s-]/)[0].replace(/\W/g, '').slice(0, 3).toUpperCase()}-${26000 + i}`,
      uuid: `inv-${seed}-${i}`,
      issueDate: `2026-10-${String(day).padStart(2, '0')}`,
      issueTime: `${String(int(8, 17)).padStart(2, '0')}:${String(int(0, 59)).padStart(2, '0')}:00`,
      sellerName: vendor.nameEn,
      sellerVat: vendor.vat,
      poNumber,
      iban: vendor.iban,
      lines: lines.map((l) => ({ ...l })),
    };
    if (has('price_mismatch')) {
      const k = int(0, inv.lines.length - 1);
      inv.lines[k].unitPrice = round2(inv.lines[k].unitPrice * (1 + int(5, 15) / 100));
    }
    if (has('no_po')) inv.poNumber = `PO-2026-${9000 + i}`;
    if (has('invalid_vat')) inv.sellerVat = pick([vendor.vat.slice(0, 14), `1${vendor.vat.slice(1)}`, `${vendor.vat.slice(0, 14)}1`, `${vendor.vat}0`]);
    if (has('iban_change')) inv.iban = `SA${String(int(10, 99))}${String(Math.floor(rnd() * 1e10)).padStart(10, '0')}${String(Math.floor(rnd() * 1e10)).padStart(10, '0')}`;

    inv.subtotal = round2(inv.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0));
    inv.vatAmount = round2(inv.subtotal * VAT_RATE);
    if (has('vat_math')) inv.vatAmount = pick([round2(inv.subtotal * 0.05), round2(inv.vatAmount + int(10, 200)), round2(inv.subtotal * 0.14)]);
    inv.total = round2(inv.subtotal + inv.vatAmount);
    const qrTotal = has('qr_tamper') ? round2(inv.total - int(50, 900)) : inv.total;
    inv.qr = encodeQR({ sellerName: inv.sellerName, vatNumber: inv.sellerVat, timestamp: `${inv.issueDate}T${inv.issueTime}`, total: f2(qrTotal), vatTotal: f2(inv.vatAmount) });

    const entry = makeEntry(i, inv, vendor, format, defs.join('+'), expectedFor(defs));
    invoices.push(entry);
    // Only invoices the deterministic tiers can read get approved without an LLM, so only those can be duplicated.
    if ((defect === 'clean' || defect === 'over_limit') && defs.length === 1 && format !== 'email') approvedClean.push({ inv, vendor });
  }

  return { vendors, purchaseOrders, goodsReceipts, lateGRNs, invoices, approvalLimit };

  function makeEntry(i, inv, vendor, format, defect, expected = EXPECTED[defect]) {
    const doc = format === 'ubl' ? renderUBL(inv) : format === 'text' ? renderText(inv, vendor) : format === 'arabic' ? renderArabic(inv, vendor) : renderEmail(inv);
    return { id: `WZN-${String(i + 1).padStart(4, '0')}`, doc, format, defect, expected, truth: inv };
  }
}
