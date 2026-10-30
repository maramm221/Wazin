// Three-way match: invoice vs purchase order vs goods receipts.

/**
 * Compare each invoice line with the purchase order and, in three-way mode, the goods received.
 * Options: priceTolerancePct (allowed price rise), invoiced (qty already billed per SKU),
 * requireReceipt (false = two-way matching against the order only).
 * @returns {{issues: {code:string,message:string,line?:string}[], lines: object[]}}
 */
export function threeWayMatch(inv, po, grns, { priceTolerancePct = 1, invoiced = {}, requireReceipt = true } = {}) {
  const issues = [];
  const lines = [];
  const received = new Map();
  // Two-way matching (no warehouse step): treat everything ordered as received.
  if (!requireReceipt) for (const l of po.lines) received.set(l.sku, l.qty);
  else for (const g of grns) for (const l of g.lines) received.set(l.sku, (received.get(l.sku) || 0) + l.qty);

  for (const il of inv.lines) {
    const pl = po.lines.find((p) => (il.sku && p.sku === il.sku) || p.name.toLowerCase() === String(il.name).toLowerCase());
    const key = il.sku || il.name;
    if (!pl) {
      issues.push({ code: 'ITEM_NOT_ON_PO', line: key, message: `"${il.name}" is not on ${po.poNumber}.`, messageAr: `البند "${il.name}" غير موجود في أمر الشراء ${po.poNumber}.` });
      lines.push({ sku: key, status: 'not_on_po' });
      continue;
    }
    const rec = received.get(pl.sku) || 0;
    const variancePct = ((il.unitPrice - pl.unitPrice) / pl.unitPrice) * 100;
    const r = { sku: pl.sku, name: pl.name, invoicedQty: il.qty, orderedQty: pl.qty, receivedQty: rec, invoicedPrice: il.unitPrice, poPrice: pl.unitPrice, variancePct: Math.round(variancePct * 100) / 100, status: 'matched' };
    if (variancePct > priceTolerancePct) {
      issues.push({ code: 'PRICE_VARIANCE', line: pl.sku, message: `${pl.name}: billed ${il.unitPrice.toFixed(2)} vs PO ${pl.unitPrice.toFixed(2)} SAR (+${r.variancePct}%).`, messageAr: `${pl.name}: سعر الفاتورة ${il.unitPrice.toFixed(2)} مقابل ${pl.unitPrice.toFixed(2)} ريال في أمر الشراء (+${r.variancePct}٪).`, overcharge: Math.round((il.unitPrice - pl.unitPrice) * il.qty * 100) / 100 });
      r.status = 'price_variance';
    }
    if (il.qty > pl.qty) {
      issues.push({ code: 'QTY_VARIANCE', line: pl.sku, message: `${pl.name}: billed ${il.qty} but only ${pl.qty} were ordered.`, messageAr: `${pl.name}: الفاتورة بكمية ${il.qty} بينما المطلوب ${pl.qty} فقط.` });
      r.status = 'over_billed';
    } else if (rec === 0) {
      issues.push({ code: 'AWAITING_GRN', line: pl.sku, message: `${pl.name}: no goods receipt yet for ${po.poNumber}.`, messageAr: `${pl.name}: لم يُسجَّل استلام البضاعة بعد لأمر الشراء ${po.poNumber}.` });
      r.status = 'awaiting_grn';
    } else if ((invoiced[pl.sku] || 0) > 0 && il.qty + invoiced[pl.sku] > rec) {
      // Goods already billed on other invoices: catches re-billing under a new number AND a new date.
      const prior = invoiced[pl.sku];
      issues.push({ code: 'ALREADY_INVOICED', line: pl.sku, message: `${pl.name}: ${prior} of the ${rec} received were already billed on other invoices; this invoice bills ${il.qty} more.`, messageAr: `${pl.name}: سبق فوترة ${prior} من أصل ${rec} مستلمة في فواتير أخرى، وهذه الفاتورة تطلب ${il.qty} إضافية.` });
      r.status = 'already_invoiced';
    } else if (il.qty > rec) {
      issues.push({ code: 'QTY_VARIANCE', line: pl.sku, message: `${pl.name}: billed ${il.qty} but warehouse received ${rec}.`, messageAr: `${pl.name}: الفاتورة بكمية ${il.qty} بينما استلم المستودع ${rec}.` });
      r.status = 'qty_variance';
    }
    lines.push(r);
  }
  return { issues, lines };
}
