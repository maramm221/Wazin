// Curated demo inbox: one invoice per real-world situation, in every input format Wazin reads.
import { encodeQR, round2, VAT_RATE } from '../src/zatca.js';
import { VENDORS, renderUBL, renderText, renderArabic, renderEmail } from './generate.js';

const V = Object.fromEntries(VENDORS.map((v) => [v.nameEn.split(/[\s-]/)[0].replace(/\W/g, '').toLowerCase(), v]));
// keys: al, riyadh, jeddah, dammam, najd, hejaz
const item = (v, sku) => {
  const [s, name, nameAr, price] = v.items.find((i) => i[0] === sku);
  return { sku: s, name, nameAr, unitPrice: price };
};

function inv(v, { no, date, time = '10:15:00', po, lines, iban, vat, vatRate = VAT_RATE, qrTotalDelta = 0 }) {
  const subtotal = round2(lines.reduce((s, l) => s + l.qty * l.unitPrice, 0));
  const vatAmount = round2(subtotal * vatRate);
  const total = round2(subtotal + vatAmount);
  const i = { invoiceNumber: no, uuid: `demo-${no}`, issueDate: date, issueTime: time, sellerName: v.nameEn, sellerVat: vat || v.vat, poNumber: po, iban: iban || v.iban, lines, subtotal, vatAmount, total };
  i.qr = encodeQR({ sellerName: i.sellerName, vatNumber: i.sellerVat, timestamp: `${date}T${time}`, total: (total + qrTotalDelta).toFixed(2), vatTotal: vatAmount.toFixed(2) });
  return i;
}

function buildSeries1() {
  const al = V.al, rt = V.riyadh, jip = V.jeddah, dl = V.dammam, najd = V.najd, hj = V.hejaz;
  const POs = [
    { poNumber: 'PO-2026-1101', vendorVat: al.vat, buyer: 'sara.alqahtani@sahara.example', lines: [{ ...item(al, 'OFF-CHR'), qty: 20 }, { ...item(al, 'OFF-DSK'), qty: 4 }] },
    { poNumber: 'PO-2026-1102', vendorVat: rt.vat, buyer: 'omar.alharbi@sahara.example', lines: [{ ...item(rt, 'TEC-LAP'), qty: 5 }, { ...item(rt, 'TEC-DCK'), qty: 5 }] },
    { poNumber: 'PO-2026-1103', vendorVat: najd.vat, buyer: 'noura.alotaibi@sahara.example', lines: [{ ...item(najd, 'CAT-LUN'), qty: 120 }, { ...item(najd, 'CAT-COF'), qty: 60 }] },
    { poNumber: 'PO-2026-1104', vendorVat: jip.vat, buyer: 'omar.alharbi@sahara.example', lines: [{ ...item(jip, 'IND-PMP'), qty: 8 }, { ...item(jip, 'IND-VLV'), qty: 12 }] },
    { poNumber: 'PO-2026-1105', vendorVat: dl.vat, buyer: 'sara.alqahtani@sahara.example', lines: [{ ...item(dl, 'LOG-CNT'), qty: 3 }, { ...item(dl, 'LOG-PAL'), qty: 10 }] },
    { poNumber: 'PO-2026-1106', vendorVat: hj.vat, buyer: 'noura.alotaibi@sahara.example', lines: [{ ...item(hj, 'FAC-CLN'), qty: 1 }, { ...item(hj, 'FAC-AC'), qty: 6 }] },
    { poNumber: 'PO-2026-1107', vendorVat: rt.vat, buyer: 'omar.alharbi@sahara.example', lines: [{ ...item(rt, 'TEC-MON'), qty: 10 }, { ...item(rt, 'TEC-HDS'), qty: 10 }] },
    { poNumber: 'PO-2026-1108', vendorVat: jip.vat, buyer: 'omar.alharbi@sahara.example', lines: [{ ...item(jip, 'IND-BRG'), qty: 200 }, { ...item(jip, 'IND-BLT'), qty: 40 }] },
    { poNumber: 'PO-2026-1109', vendorVat: al.vat, buyer: 'sara.alqahtani@sahara.example', lines: [{ ...item(al, 'OFF-TNR'), qty: 15 }, { ...item(al, 'OFF-PPR'), qty: 30 }] },
    { poNumber: 'PO-2026-1110', vendorVat: najd.vat, buyer: 'noura.alotaibi@sahara.example', lines: [{ ...item(najd, 'CAT-EVT'), qty: 2 }] },
    { poNumber: 'PO-2026-1111', vendorVat: dl.vat, buyer: 'sara.alqahtani@sahara.example', lines: [{ ...item(dl, 'LOG-STR'), qty: 80 }, { ...item(dl, 'LOG-PAL'), qty: 6 }] },
    { poNumber: 'PO-2026-1112', vendorVat: hj.vat, buyer: 'noura.alotaibi@sahara.example', lines: [{ ...item(hj, 'FAC-PST'), qty: 3 }, { ...item(hj, 'FAC-AC'), qty: 4 }] },
  ];
  const full = (po) => ({ grnNumber: `GRN-${po.poNumber.slice(-4)}`, poNumber: po.poNumber, lines: po.lines.map((l) => ({ sku: l.sku, qty: l.qty })) });
  const P = Object.fromEntries(POs.map((p) => [p.poNumber.slice(-4), p]));
  const goodsReceipts = POs.filter((p) => !['1109', '1108'].includes(p.poNumber.slice(-4))).map(full);
  goodsReceipts.push({ grnNumber: 'GRN-1108', poNumber: 'PO-2026-1108', lines: [{ sku: 'IND-BRG', qty: 160 }, { sku: 'IND-BLT', qty: 40 }] }); // short delivery
  const lateGRNs = [full(P['1109'])];
  const L = (po) => po.lines.map((l) => ({ ...l }));

  const i1 = inv(al, { no: 'ALN-24117', date: '2026-10-25', po: 'PO-2026-1101', lines: L(P['1101']) });
  const list = [
    { label: 'Office furniture', story: 'Clean ZATCA e-invoice with a 2% early-payment discount', inv: i1, v: al, fmt: 'ubl' },
    { label: 'Laptops & docks', story: 'Bilingual PDF-style text invoice, everything matches', inv: inv(rt, { no: 'RTD-88310', date: '2026-10-26', po: 'PO-2026-1102', lines: L(P['1102']) }), v: rt, fmt: 'text' },
    { label: 'Staff catering', story: 'Arabic-only invoice with Arabic-Indic digits', inv: inv(najd, { no: 'NJD-5521', date: '2026-10-26', po: 'PO-2026-1103', lines: L(P['1103']) }), v: najd, fmt: 'arabic' },
    { label: 'Pumps & valves', story: 'Large invoice: every check passes but it is above the auto-approval limit', inv: inv(jip, { no: 'JIP-30092', date: '2026-10-24', po: 'PO-2026-1104', lines: L(P['1104']) }), v: jip, fmt: 'ubl' },
    { label: 'Office furniture (again)', story: 'The same invoice resubmitted under a new number', inv: { ...i1, invoiceNumber: 'ALN-24117-R', uuid: 'demo-dup' }, v: al, fmt: 'text' },
    { label: 'Container haulage', story: '"Please pay our new bank account" — the payment-diversion pattern', inv: inv(dl, { no: 'DLC-7781', date: '2026-10-27', po: 'PO-2026-1105', lines: L(P['1105']), iban: 'SA7720000002480123456789' }), v: dl, fmt: 'ubl' },
    { label: 'Office cleaning', story: 'Supplier printed its CR number instead of its VAT number', inv: inv(hj, { no: 'HCF-1019', date: '2026-10-22', po: 'PO-2026-1106', lines: L(P['1106']), vat: '1010123456' }), v: hj, fmt: 'text' },
    { label: 'Monitors & headsets', story: 'Unit price billed 9% above the agreed PO price', inv: inv(rt, { no: 'RTD-88342', date: '2026-10-27', po: 'PO-2026-1107', lines: L(P['1107']).map((l) => (l.sku === 'TEC-MON' ? { ...l, unitPrice: 970 } : l)) }), v: rt, fmt: 'ubl' },
    { label: 'Bearings & belts', story: 'Billed 200 bearings, warehouse received 160', inv: inv(jip, { no: 'JIP-30117', date: '2026-10-27', po: 'PO-2026-1108', lines: L(P['1108']) }), v: jip, fmt: 'ubl' },
    { label: 'Toner & paper', story: 'Invoice arrived before the goods were received', inv: inv(al, { no: 'ALN-24133', date: '2026-10-28', po: 'PO-2026-1109', lines: L(P['1109']) }), v: al, fmt: 'ubl' },
    { label: 'Event catering', story: 'VAT charged at the old 5% rate', inv: inv(najd, { no: 'NJD-5540', date: '2026-10-28', po: 'PO-2026-1110', lines: L(P['1110']), vatRate: 0.05 }), v: najd, fmt: 'arabic' },
    { label: 'Pest control & AC', story: 'QR code total does not match the printed total', inv: inv(hj, { no: 'HCF-1033', date: '2026-10-28', po: 'PO-2026-1112', lines: L(P['1112']), qrTotalDelta: -1150 }), v: hj, fmt: 'ubl' },
    { label: 'Storage & pallets', story: 'Free-text email invoice: needs the LLM tier to read', inv: inv(dl, { no: 'DLC-7790', date: '2026-10-28', po: 'PO-2026-1111', lines: L(P['1111']) }), v: dl, fmt: 'email' },
  ];
  const render = { ubl: renderUBL, text: renderText, arabic: renderArabic, email: renderEmail };
  const AR = {"Office furniture": ["أثاث مكتبي", "فاتورة إلكترونية سليمة مع خصم ٢٪ للدفع المبكر"], "Laptops & docks": ["حواسيب ومنصات توصيل", "فاتورة نصية ثنائية اللغة، كل شيء مطابق"], "Staff catering": ["إعاشة الموظفين", "فاتورة عربية بالكامل بأرقام عربية"], "Pumps & valves": ["مضخات وصمامات", "فاتورة كبيرة: اجتازت كل الفحوصات لكنها أعلى من حد الاعتماد التلقائي"], "Office furniture (again)": ["أثاث مكتبي (مرة أخرى)", "الفاتورة نفسها أُعيد إرسالها برقم جديد"], "Container haulage": ["نقل حاويات", "\"ادفعوا لحسابنا الجديد\": نمط تحويل الدفعات الاحتيالي"], "Office cleaning": ["تنظيف المكاتب", "المورد طبع رقم السجل التجاري بدل الرقم الضريبي"], "Monitors & headsets": ["شاشات وسماعات", "سعر الوحدة أعلى بـ٩٪ من سعر أمر الشراء"], "Bearings & belts": ["محامل وسيور", "الفاتورة ٢٠٠ محمل والمستودع استلم ١٦٠"], "Toner & paper": ["أحبار وورق", "وصلت الفاتورة قبل وصول البضاعة"], "Event catering": ["إعاشة فعالية", "الضريبة محسوبة بالنسبة القديمة ٥٪"], "Pest control & AC": ["مكافحة حشرات وتكييف", "إجمالي رمز QR لا يطابق الإجمالي المطبوع"], "Storage & pallets": ["تخزين ومنصات", "فاتورة بريد إلكتروني بنص حر تحتاج القراءة بالذكاء الاصطناعي"]};
  const inbox = list.map((x, k) => ({ id: `WZN-${String(k + 1).padStart(4, '0')}`, label: x.label, story: x.story, labelAr: AR[x.label]?.[0], storyAr: AR[x.label]?.[1], vendor: x.v.nameEn, vendorAr: x.v.nameAr, format: x.fmt, total: x.inv.total, doc: render[x.fmt](x.inv, x.v) }));
  return { vendors: VENDORS, purchaseOrders: POs, goodsReceipts, lateGRNs, inbox, approvalLimit: 50000 };
}

/**
 * series 1: the inbox processed when a demo company is created.
 * series 2: the same 13 situations on separate orders, with new invoice numbers, offered as
 * "try a sample" so a visitor sees a fresh result instead of a duplicate of the inbox.
 */
export function buildDemo(series = 1) {
  const d = buildSeries1();
  if (series === 1) return d;
  const sw = (x) => String(x)
    .replaceAll('PO-2026-11', 'PO-2026-12')
    .replaceAll('GRN-11', 'GRN-12')
    .replace(/\b(ALN|RTD|NJD|JIP|DLC|HCF)-(\d+)/g, (_, p, n) => `${p}-${Number(n) + 1000}`);
  const deep = (o) => JSON.parse(sw(JSON.stringify(o)));
  return {
    ...d,
    purchaseOrders: deep(d.purchaseOrders),
    goodsReceipts: deep(d.goodsReceipts),
    lateGRNs: deep(d.lateGRNs),
    inbox: d.inbox.map((i) => ({ ...i, doc: sw(i.doc) })),
  };
}
