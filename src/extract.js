// Tiered invoice extraction — the "less compute" core of Wazin.
//   Tier 1  ZATCA UBL 2.1 XML  -> deterministic parse, 0 LLM tokens
//   Tier 2  Semi-structured text (English / Arabic labels) -> regex, 0 LLM tokens
//   Tier 3  Anything else (free-text email, OCR output) -> ONE LLM call, output re-validated
// The LLM is never trusted for arithmetic or compliance: its output goes through the same
// deterministic checks as tiers 1-2.

export const REQUIRED_FIELDS = ['invoiceNumber', 'issueDate', 'sellerName', 'sellerVat', 'poNumber', 'lines', 'subtotal', 'vatAmount', 'total'];

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;
/** Convert Arabic-Indic and Persian digits (and Arabic separators) to Western digits. */
export function normalizeDigits(s) {
  return String(s)
    .replace(ARABIC_DIGITS, (d) => String((d.charCodeAt(0) & 0xf) % 10))
    .replace(/٫/g, '.') // Arabic decimal separator
    .replace(/٬/g, ','); // Arabic thousands separator
}
export const toNumber = (s) => (s === undefined || s === null || s === '' ? undefined : Number(normalizeDigits(s).replace(/[,\s]|SAR|ر\.س|ريال/g, '')));

/** List the required fields that extraction could not find; an empty list means the invoice is complete. */
export function missingFields(inv) {
  return REQUIRED_FIELDS.filter((f) => {
    const v = inv[f];
    if (f === 'lines') return !Array.isArray(v) || v.length === 0;
    return v === undefined || v === null || v === '' || (typeof v === 'number' && Number.isNaN(v));
  });
}

// ---------------- Tier 1: UBL XML ----------------
const esc = (t) => t.replace(':', '\\:');
function block(xml, tag) {
  if (typeof xml !== 'string') return undefined;
  const m = xml.match(new RegExp(`<${esc(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc(tag)}>`));
  return m ? m[1] : undefined;
}
function blocks(xml, tag) {
  if (typeof xml !== 'string') return [];
  return [...xml.matchAll(new RegExp(`<${esc(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc(tag)}>`, 'g'))].map((m) => m[1]);
}
const val = (xml, tag) => {
  const b = xml === undefined ? undefined : block(xml, tag);
  return b === undefined ? undefined : unescapeXml(b.trim());
};
function unescapeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Tier 1: read a ZATCA UBL 2.1 XML e-invoice directly. No AI, no tokens. Returns null if it is not UBL. */
export function parseUBL(xml) {
  // Strip the line items first so top-level <cbc:ID> is the invoice number.
  const head = xml.replace(/<cac:InvoiceLine[\s\S]*?<\/cac:InvoiceLine>/g, '');
  const supplier = block(xml, 'cac:AccountingSupplierParty');
  const qrRef = blocks(xml, 'cac:AdditionalDocumentReference').find((b) => val(b, 'cbc:ID') === 'QR');
  const totals = block(xml, 'cac:LegalMonetaryTotal');
  const taxTotal = block(xml, 'cac:TaxTotal');
  const lines = blocks(xml, 'cac:InvoiceLine').map((l) => ({
    sku: val(block(l, 'cac:SellersItemIdentification'), 'cbc:ID'),
    name: val(block(l, 'cac:Item'), 'cbc:Name'),
    qty: toNumber(val(l, 'cbc:InvoicedQuantity')),
    unitPrice: toNumber(val(block(l, 'cac:Price'), 'cbc:PriceAmount')),
  }));
  return {
    invoiceNumber: val(head, 'cbc:ID'),
    issueDate: val(head, 'cbc:IssueDate'),
    issueTime: val(head, 'cbc:IssueTime'),
    sellerName: val(block(supplier, 'cac:PartyLegalEntity'), 'cbc:RegistrationName'),
    sellerVat: val(block(supplier, 'cac:PartyTaxScheme'), 'cbc:CompanyID'),
    poNumber: val(block(xml, 'cac:OrderReference'), 'cbc:ID'),
    iban: val(block(xml, 'cac:PayeeFinancialAccount'), 'cbc:ID'),
    currency: val(head, 'cbc:DocumentCurrencyCode') || 'SAR',
    lines,
    subtotal: toNumber(val(totals, 'cbc:TaxExclusiveAmount')),
    vatAmount: toNumber(val(taxTotal, 'cbc:TaxAmount')),
    total: toNumber(val(totals, 'cbc:TaxInclusiveAmount')),
    qr: qrRef ? val(qrRef, 'cbc:EmbeddedDocumentBinaryObject') : undefined,
  };
}

// ---------------- Tier 2: labelled text (EN/AR) ----------------
const LABELS = {
  invoiceNumber: ['Invoice No', 'Invoice Number', 'Invoice #', 'رقم الفاتورة'],
  issueDate: ['Date', 'Invoice Date', 'تاريخ الفاتورة', 'التاريخ'],
  sellerName: ['Seller', 'Supplier', 'Vendor', 'المورد', 'البائع'],
  sellerVat: ['Seller VAT', 'VAT No', 'VAT Number', 'TRN', 'الرقم الضريبي'],
  poNumber: ['PO', 'PO Number', 'Purchase Order', 'أمر الشراء', 'رقم أمر الشراء'],
  iban: ['IBAN', 'الآيبان', 'رقم الآيبان'],
  subtotal: ['Subtotal', 'Total excl. VAT', 'المجموع', 'الإجمالي قبل الضريبة'],
  vatAmount: ['VAT 15%', 'VAT Amount', 'VAT', 'ضريبة القيمة المضافة'],
  total: ['Total', 'Total incl. VAT', 'Grand Total', 'الإجمالي', 'الإجمالي شامل الضريبة'],
  qr: ['QR'],
};
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&');

function findLabel(lines, labels) {
  // A line looks like "Label / تسمية: value" — match if ANY label alternative appears before the colon.
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).split('/').map((k) => k.trim().toLowerCase());
    if (labels.some((l) => key.includes(l.toLowerCase()))) return line.slice(idx + 1).trim();
  }
  return undefined;
}

/** Tier 2: read labelled Arabic or English invoice text with exact patterns. No AI, no tokens. */
export function parseText(text) {
  const t = normalizeDigits(text);
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const get = (f) => findLabel(lines, LABELS[f]);
  const date = get('issueDate');
  // ISO dates, or day/month/year as printed on many invoices (14/10/2026 -> 2026-10-14).
  const dmy = date && date.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/);
  const dm = (date && date.match(/(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?/))
    || (dmy && Number(dmy[2]) <= 12 ? [null, `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`] : null);
  const seller = get('sellerName');
  const items = lines
    .filter((l) => /^[-•*]\s*/.test(l) && l.includes('|'))
    .map((l) => {
      const [sku, name, qp] = l.replace(/^[-•*]\s*/, '').split('|').map((s) => s.trim());
      const m = qp && qp.match(/([\d.,]+)\s*[x×]\s*([\d.,]+)/);
      return m ? { sku, name, qty: toNumber(m[1]), unitPrice: toNumber(m[2]) } : null;
    })
    .filter(Boolean);
  const vatRaw = get('sellerVat');
  return {
    invoiceNumber: get('invoiceNumber'),
    issueDate: dm ? dm[1] : undefined,
    issueTime: dm ? dm[2] : undefined,
    sellerName: seller ? seller.split('|')[0].trim() : undefined,
    sellerVat: vatRaw ? vatRaw.replace(/\s/g, '') : undefined,
    poNumber: get('poNumber'),
    iban: get('iban')?.replace(/\s/g, ''),
    currency: 'SAR',
    lines: items,
    subtotal: toNumber(get('subtotal')),
    vatAmount: toNumber(get('vatAmount')),
    total: toNumber(get('total')),
    qr: get('qr'),
  };
}

// ---------------- Tier 3: LLM ----------------
/** Tier 3 prompt: ask a language model to return the invoice fields as JSON, once. */
export function buildLLMPrompt(doc) {
  return `Extract the supplier invoice below into JSON. Reply with JSON only, no prose.
Schema: {"invoiceNumber":str,"issueDate":"YYYY-MM-DD","sellerName":str,"sellerVat":str (digits only),"poNumber":str,"iban":str|null,"lines":[{"sku":str|null,"name":str,"qty":num,"unitPrice":num}],"subtotal":num,"vatAmount":num,"total":num,"qr":str|null}
Use null when a value is not present. Never compute or guess numbers that are not written in the text.
Invoice:
"""
${doc}
"""`;
}

/** Parse and sanitise the model's JSON reply; anything malformed is rejected, never guessed. */
export function parseLLMJson(raw) {
  const s = String(raw);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('LLM reply contained no JSON object');
  const o = JSON.parse(s.slice(start, end + 1));
  const num = (v) => (v === null || v === undefined ? undefined : toNumber(v));
  return {
    invoiceNumber: o.invoiceNumber ?? undefined,
    issueDate: o.issueDate ?? undefined,
    sellerName: o.sellerName ?? undefined,
    sellerVat: o.sellerVat ? String(o.sellerVat).replace(/\D/g, '') : undefined,
    poNumber: o.poNumber ?? undefined,
    iban: o.iban ? String(o.iban).replace(/\s/g, '') : undefined,
    currency: 'SAR',
    lines: Array.isArray(o.lines) ? o.lines.map((l) => ({ sku: l.sku ?? undefined, name: l.name, qty: num(l.qty), unitPrice: num(l.unitPrice) })) : [],
    subtotal: num(o.subtotal),
    vatAmount: num(o.vatAmount),
    total: num(o.total),
    qr: o.qr ?? undefined,
  };
}

export const estimateTokens = (s) => Math.ceil(String(s).length / 4);

/** Detect whether the input is ZATCA UBL XML or text, so the cheapest reader is tried first. */
export function detectFormat(doc) {
  const t = String(doc).trim();
  if (t.startsWith('<') && /<(\w+:)?Invoice[\s>]/.test(t)) return 'ubl';
  return 'text';
}

/**
 * Extract a normalized invoice using the cheapest tier that yields all required fields.
 * @param {string} doc
 * @param {{llm?: (prompt:string)=>Promise<string>}} opts
 */
export async function extract(doc, { llm } = {}) {
  const format = detectFormat(doc);
  const usage = { tier: 0, llmCalls: 0, llmTokens: 0 };
  let inv;
  if (format === 'ubl') {
    inv = parseUBL(doc);
    usage.tier = 1;
  } else {
    inv = parseText(doc);
    usage.tier = 2;
  }
  let missing = missingFields(inv);
  if (missing.length && llm) {
    const prompt = buildLLMPrompt(doc);
    usage.tier = 3;
    usage.llmCalls = 1;
    try {
      const reply = await llm(prompt);
      usage.llmTokens = estimateTokens(prompt) + estimateTokens(reply);
      const fromLLM = parseLLMJson(reply);
      // Keep deterministic values where we have them; fill gaps from the LLM.
      for (const [k, v] of Object.entries(fromLLM)) {
        const cur = inv[k];
        const empty = cur === undefined || cur === '' || (Array.isArray(cur) && cur.length === 0) || (typeof cur === 'number' && Number.isNaN(cur));
        if (empty && v !== undefined) inv[k] = v;
      }
      missing = missingFields(inv);
    } catch (e) {
      usage.llmError = e.message;
    }
  }
  return { invoice: inv, format, missing, usage };
}
