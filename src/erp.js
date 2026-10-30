// In-memory ERP adapter: supplier list, purchase orders, goods receipts (GRN), ledger.
// Used by the benchmark, the unit tests and the CLI. The web server uses the SQLite adapter
// in server/store.js, which implements exactly the same methods.

export class ERP {
  constructor({ vendors = [], purchaseOrders = [], goodsReceipts = [], approvalLimit = 50000 } = {}) {
    this.vendors = new Map(vendors.map((v) => [v.vat, v]));
    this.pos = new Map(purchaseOrders.map((p) => [p.poNumber, p]));
    this.grns = new Map();
    goodsReceipts.forEach((g) => this.addGRN(g));
    this.limit = approvalLimit; // SAR; above this a person signs off
    this.ledger = [];
    this.processed = new Map(); // vendorVat|invoiceNumber -> invoice id
    this.fingerprints = new Map(); // vendorVat|PO|total|date -> invoice id (catches re-numbered duplicates)
    this.parked = new Map(); // invoice id -> { doc, poNumber }
    this.claims = new Map(); // invoice id -> { poNumber, lines } for invoices that are paid, approved or waiting
  }
  approvalLimit() {
    return this.limit;
  }
  findVendor({ sellerVat, sellerName }) {
    if (sellerVat && this.vendors.has(sellerVat)) return this.vendors.get(sellerVat);
    if (!sellerName) return undefined;
    const n = sellerName.trim().toLowerCase();
    return [...this.vendors.values()].find((v) => v.nameEn.toLowerCase() === n || v.nameAr === sellerName.trim());
  }
  getPO(poNumber) {
    return poNumber ? this.pos.get(String(poNumber).trim()) : undefined;
  }
  getGRNs(poNumber) {
    return this.grns.get(poNumber) || [];
  }
  addGRN(grn) {
    const list = this.grns.get(grn.poNumber) || [];
    list.push(grn);
    this.grns.set(grn.poNumber, list);
  }
  static keys(inv, vendor) {
    const vat = vendor?.vat || inv.sellerVat;
    return [`${vat}|${inv.invoiceNumber}`, `${vat}|${inv.poNumber}|${Number(inv.total).toFixed(2)}|${inv.issueDate}`];
  }
  duplicateOf(inv, vendor) {
    const [a, b] = ERP.keys(inv, vendor);
    return this.processed.get(a) || this.fingerprints.get(b);
  }
  markProcessed(id, inv, vendor) {
    const [a, b] = ERP.keys(inv, vendor);
    this.processed.set(a, id);
    this.fingerprints.set(b, id);
    this.claims.set(id, { poNumber: inv.poNumber, lines: inv.lines });
  }
  /** Quantity per item already billed on this PO by other active invoices. */
  invoicedQty(poNumber, excludeId) {
    const out = {};
    for (const [id, c] of this.claims) if (id !== excludeId && c.poNumber === poNumber) for (const l of c.lines) out[l.sku] = (out[l.sku] || 0) + l.qty;
    return out;
  }
  park(id, doc, poNumber) {
    this.parked.set(id, { doc, poNumber });
  }
  parkedOn(poNumber) {
    return [...this.parked].filter(([, p]) => p.poNumber === poNumber).map(([id, p]) => ({ id, doc: p.doc }));
  }
  /** Forget an invoice's parking and duplicate keys so it can be checked again. */
  release(id) {
    this.parked.delete(id);
    this.claims.delete(id);
    for (const m of [this.processed, this.fingerprints]) for (const [k, v] of m) if (v === id) m.delete(k);
  }
  post(entry) {
    this.ledger.push(entry);
    return entry;
  }
}
