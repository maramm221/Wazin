// Wazin — the autonomous Accounts Payable agent.
// Owns the invoice from intake to scheduled payment; hands off to a human only on exceptions,
// with the evidence and a ready-to-send bilingual message.
//
// The agent talks to its system of record only through an ERP adapter (see erp.js for the
// in-memory version and server/store.js for the SQLite one). Every adapter call is awaited,
// so the same agent runs against memory, a database, or a remote ERP API.

import { extract } from './extract.js';
import { checkCompliance, round2 } from './zatca.js';
import { threeWayMatch } from './match.js';

/** Every outcome Wazin can reach for an invoice, with English and Arabic labels. */
export const DECISIONS = {
  APPROVED_AUTO: { en: 'Approved & scheduled', ar: 'معتمدة ومجدولة للدفع' },
  APPROVAL_REQUIRED: { en: 'Waiting for manager approval', ar: 'بانتظار اعتماد المدير' },
  PARKED: { en: 'Waiting for goods receipt', ar: 'بانتظار استلام البضاعة' },
  EXCEPTION: { en: 'Problem sent to owner', ar: 'مشكلة أُحيلت للمسؤول' },
  BLOCKED: { en: 'Payment blocked', ar: 'الدفع موقوف' },
  REVIEW: { en: 'Needs data review', ar: 'تحتاج مراجعة البيانات' },
};

/** The team that owns the next step for an invoice (NONE when Wazin finished it alone). */
export const OWNERS = {
  AP: { en: 'Accounts Payable', ar: 'الحسابات الدائنة' },
  VENDOR: { en: 'Supplier', ar: 'المورد' },
  PROCUREMENT: { en: 'Procurement', ar: 'المشتريات' },
  WAREHOUSE: { en: 'Warehouse', ar: 'المستودع' },
  TREASURY: { en: 'Treasury', ar: 'الخزينة' },
  FINANCE_MANAGER: { en: 'Finance Manager', ar: 'المدير المالي' },
  NONE: { en: 'No one', ar: 'لا أحد' },
};

export const STEP_NAMES = {
  read: { en: 'Read invoice', ar: 'قراءة الفاتورة' },
  zatca: { en: 'ZATCA compliance', ar: 'الامتثال لهيئة الزكاة' },
  vendor: { en: 'Supplier & bank account', ar: 'المورد والحساب البنكي' },
  duplicate: { en: 'Duplicate check', ar: 'فحص التكرار' },
  match: { en: 'Order & delivery match', ar: 'مطابقة الطلب والاستلام' },
  post: { en: 'Post & schedule payment', ar: 'القيد وجدولة الدفع' },
  approval: { en: 'Approval request', ar: 'طلب الاعتماد' },
  park: { en: 'Wait for goods', ar: 'انتظار البضاعة' },
  handoff: { en: 'Hand-off', ar: 'الإحالة' },
  resumed: { en: 'Resumed automatically', ar: 'استؤنفت تلقائياً' },
};

/** Reason codes that are the supplier's to fix (ZATCA format and maths problems). */
export const COMPLIANCE_CODES = ['INVALID_VAT_NUMBER', 'VAT_CALC_ERROR', 'QR_MISMATCH', 'QR_MISSING'];

const FIELD_AR = { invoiceNumber: 'رقم الفاتورة', issueDate: 'التاريخ', sellerName: 'اسم المورد', sellerVat: 'الرقم الضريبي', poNumber: 'رقم أمر الشراء', lines: 'البنود', subtotal: 'المجموع', vatAmount: 'الضريبة', total: 'الإجمالي' };

export const addDays = (iso, d) => {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
};
export const sar = (n) => `SAR ${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sarAr = (n) => `${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ريال`;
export const maskIban = (iban) => (iban ? `${iban.slice(0, 4)} •••• ${iban.slice(-4)}` : '—');

/**
 * The accounts payable agent. Give it an ERP adapter (see src/erp.js or server/store.js SqlERP)
 * and call process(doc) for each incoming invoice. It never pays on a model's word: every
 * number goes through the same rules, and the decision follows a fixed priority (README).
 */
export class WazinAgent {
  /**
   * @param {object} erp  adapter: findVendor, getPO, getGRNs, duplicateOf, markProcessed, post, park, approvalLimit
   * @param {{llm?: (prompt:string)=>Promise<string>, skip?: string[]}} opts
   *   skip: checks to switch off ('zatca', 'bank', 'duplicate', 'match'). Only the ablation study
   *   (eval/heldout.js) uses it, to measure what each check contributes; the product never does.
   */
  constructor(erp, { llm, skip = [] } = {}) {
    this.erp = erp;
    this.llm = llm;
    this.skip = new Set(skip);
    this.seq = 0;
    this.log = [];
  }

  async process(doc, { id } = {}) {
    const t0 = performance.now();
    const rid = id || `WZN-${String(++this.seq).padStart(4, '0')}`;
    // The company's own settings (matching mode, price tolerance, early payment); defaults if none.
    const pol = (this.erp.policy && (await this.erp.policy())) || {};
    this.policyNow = pol;
    const steps = [];
    const step = (key, status, detail, detailAr) => steps.push({ key, name: STEP_NAMES[key].en, nameAr: STEP_NAMES[key].ar, status, detail, detailAr });
    const issues = [];

    // 1. Intake & extraction (cheapest tier first)
    const ex = await extract(doc, { llm: this.llm });
    const inv = ex.invoice;
    const tier = {
      1: ['ZATCA e-invoice XML, read directly (no AI needed)', 'فاتورة إلكترونية XML قُرئت مباشرة (دون ذكاء اصطناعي)'],
      2: ['Invoice text, read directly (no AI needed)', 'نص الفاتورة قُرئ مباشرة (دون ذكاء اصطناعي)'],
      3: [`Free text, read by AI (${ex.usage.llmTokens} tokens) and re-checked`, `نص حر قرأه الذكاء الاصطناعي (${ex.usage.llmTokens} وحدة) ثم أُعيد التحقق منه`],
    }[ex.usage.tier];
    if (ex.missing.length) {
      const reason = ex.usage.llmError ? ' The AI reader failed, so a person must check it.' : !this.llm ? ' AI reading is not switched on for free-text invoices.' : '';
      step('read', 'fail', `${tier[0]}: could not find ${ex.missing.join(', ')}.${reason}`,
        `${tier[1]}: تعذّر العثور على ${ex.missing.map((f) => FIELD_AR[f] || f).join('، ')}.`);
      issues.push({ code: 'EXTRACTION_INCOMPLETE', message: `Missing: ${ex.missing.join(', ')}`, messageAr: `حقول ناقصة: ${ex.missing.map((f) => FIELD_AR[f] || f).join('، ')}` });
      return this.#finish({ rid, t0, steps, issues, inv, ex, decision: 'REVIEW', owner: 'AP', doc });
    }
    step('read', 'ok', `${tier[0]}: ${inv.invoiceNumber} from ${inv.sellerName}, ${sar(inv.total)}, ${inv.lines.length} line(s).`,
      `${tier[1]}: ${inv.invoiceNumber} من ${inv.sellerName}، ${sarAr(inv.total)}، ${inv.lines.length} بند.`);

    // 2. ZATCA compliance
    const comp = this.skip.has('zatca') ? [] : checkCompliance(inv);
    issues.push(...comp);
    step('zatca', comp.length ? 'fail' : 'ok',
      comp.length ? comp.map((c) => c.message).join(' ') : 'VAT number, 15% VAT maths and QR code all pass.',
      comp.length ? comp.map((c) => c.messageAr).join(' ') : 'الرقم الضريبي وحساب ضريبة ١٥٪ ورمز QR كلها سليمة.');

    // 3. Vendor master & bank details
    const vendor = await this.erp.findVendor(inv);
    if (!vendor) {
      issues.push({ code: 'VENDOR_UNKNOWN', message: `${inv.sellerName} (${inv.sellerVat}) is not a registered supplier.`, messageAr: `${inv.sellerName} (${inv.sellerVat}) ليس مورداً مسجلاً.` });
      step('vendor', 'fail', 'Unknown supplier: not in the supplier list.', 'مورد غير معروف: غير موجود في قائمة الموردين.');
    } else if (!this.skip.has('bank') && inv.iban && inv.iban !== vendor.iban) {
      issues.push({ code: 'BANK_DETAILS_CHANGED', message: `Invoice asks for payment to ${maskIban(inv.iban)}, but the verified account on file is ${maskIban(vendor.iban)}.`, messageAr: `الفاتورة تطلب الدفع إلى ${maskIban(inv.iban)} بينما الحساب الموثّق لدينا ${maskIban(vendor.iban)}.` });
      step('vendor', 'fail', 'The bank account on the invoice is different from the verified one. This is the most common payment fraud.',
        'الحساب البنكي في الفاتورة يختلف عن الحساب الموثّق. هذا أكثر أنماط الاحتيال في الدفع شيوعاً.');
    } else {
      step('vendor', 'ok', `${vendor.nameEn} is a registered supplier and the bank account matches.`, `${vendor.nameAr} مورد مسجّل والحساب البنكي مطابق.`);
    }

    // 4. Duplicate detection (same number, or same vendor+PO+amount+date under a new number)
    const dup = this.skip.has('duplicate') ? null : await this.erp.duplicateOf(inv, vendor);
    if (dup && dup !== rid) {
      issues.push({ code: 'DUPLICATE', message: `Same invoice already handled as ${dup}.`, messageAr: `الفاتورة نفسها عولجت سابقاً برقم ${dup}.` });
      step('duplicate', 'fail', `Duplicate of ${dup}. Paying it would pay the supplier twice.`, `مكررة للفاتورة ${dup}. دفعها يعني الدفع مرتين.`);
    } else step('duplicate', 'ok', 'Not paid before, under this or any other invoice number.', 'لم تُدفع سابقاً بهذا الرقم أو بأي رقم آخر.');

    // 5. Three-way match
    const po = await this.erp.getPO(inv.poNumber);
    let match = { issues: [], lines: [] };
    if (!po) {
      issues.push({ code: 'PO_NOT_FOUND', message: `Purchase order ${inv.poNumber} does not exist.`, messageAr: `أمر الشراء ${inv.poNumber} غير موجود.` });
      step('match', 'fail', `Purchase order ${inv.poNumber} not found.`, `أمر الشراء ${inv.poNumber} غير موجود.`);
    } else {
      const invoiced = this.erp.invoicedQty && !this.skip.has('duplicate') ? await this.erp.invoicedQty(po.poNumber, rid) : {};
      const requireReceipt = pol.matching !== 'two';
      match = this.skip.has('match') ? { issues: [], lines: [] } : threeWayMatch(inv, po, requireReceipt ? await this.erp.getGRNs(po.poNumber) : [], { invoiced, requireReceipt, priceTolerancePct: pol.priceTolerancePct ?? 1 });
      // A duplicate already explains any re-billed goods; report it once.
      if (issues.some((i) => i.code === 'DUPLICATE')) match.issues = match.issues.filter((i) => i.code !== 'ALREADY_INVOICED');
      issues.push(...match.issues);
      const onlyWaiting = match.issues.length && match.issues.every((i) => i.code === 'AWAITING_GRN');
      step('match', match.issues.length ? (onlyWaiting ? 'warn' : 'fail') : 'ok',
        match.issues.length ? match.issues.map((i) => i.message).join(' ') : requireReceipt ? `Invoice matches ${po.poNumber} and the goods received, on every line.` : `Invoice matches ${po.poNumber} on every line.`,
        match.issues.length ? match.issues.map((i) => i.messageAr).join(' ') : requireReceipt ? `الفاتورة تطابق ${po.poNumber} والبضاعة المستلمة في كل البنود.` : `الفاتورة تطابق ${po.poNumber} في كل البنود.`);
    }

    // 6. Decide (riskiest finding wins)
    const has = (c) => issues.some((i) => i.code === c);
    let decision, owner;
    if (has('DUPLICATE') || has('ALREADY_INVOICED')) [decision, owner] = ['BLOCKED', 'AP'];
    else if (has('BANK_DETAILS_CHANGED')) [decision, owner] = ['BLOCKED', 'TREASURY'];
    else if (has('VENDOR_UNKNOWN')) [decision, owner] = ['EXCEPTION', 'PROCUREMENT'];
    else if (COMPLIANCE_CODES.some(has)) [decision, owner] = ['EXCEPTION', 'VENDOR'];
    else if (has('PO_NOT_FOUND') || has('PRICE_VARIANCE') || has('ITEM_NOT_ON_PO')) [decision, owner] = ['EXCEPTION', 'PROCUREMENT'];
    else if (has('QTY_VARIANCE')) [decision, owner] = ['EXCEPTION', 'WAREHOUSE'];
    else if (has('AWAITING_GRN')) [decision, owner] = ['PARKED', 'WAREHOUSE'];
    else if (inv.total > (await this.erp.approvalLimit())) [decision, owner] = ['APPROVAL_REQUIRED', 'FINANCE_MANAGER'];
    else [decision, owner] = ['APPROVED_AUTO', 'NONE'];

    return this.#finish({ rid, t0, steps, issues, inv, ex, decision, owner, vendor, po, match, doc });
  }

  /** Event: warehouse posts a goods receipt. Re-runs every invoice parked on that PO — no human needed. */
  async onGoodsReceipt(grn) {
    await this.erp.addGRN(grn);
    const resumed = [];
    for (const p of await this.erp.parkedOn(grn.poNumber)) {
      await this.erp.release(p.id);
      const r = await this.process(p.doc, { id: p.id });
      r.steps.unshift({ key: 'resumed', name: STEP_NAMES.resumed.en, nameAr: STEP_NAMES.resumed.ar, status: 'ok',
        detail: `Goods receipt ${grn.grnNumber} was posted for ${grn.poNumber}, so Wazin checked the invoice again.`,
        detailAr: `سُجّل سند الاستلام ${grn.grnNumber} لأمر الشراء ${grn.poNumber}، فأعاد وازِن فحص الفاتورة.` });
      resumed.push(r);
    }
    return resumed;
  }

  /** Payment schedule: take an early-payment discount when the supplier offers one. */
  schedule(inv, vendor) {
    const terms = vendor?.paymentTermsDays ?? 30;
    const disc = vendor?.earlyPayDiscount; // {pct, days}
    if (disc && disc.pct > 0 && this.policyNow?.earlyPay !== false) {
      const discount = round2((inv.total * disc.pct) / 100);
      return { amount: round2(inv.total - discount), discount, payOn: addDays(inv.issueDate, disc.days), dueDate: addDays(inv.issueDate, terms) };
    }
    return { amount: inv.total, discount: 0, payOn: addDays(inv.issueDate, terms), dueDate: addDays(inv.issueDate, terms) };
  }

  async #finish({ rid, t0, steps, issues, inv, ex, decision, owner, vendor, po, doc }) {
    const step = (key, status, detail, detailAr) => steps.push({ key, name: STEP_NAMES[key].en, nameAr: STEP_NAMES[key].ar, status, detail, detailAr });
    const result = {
      id: rid, decision, decisionLabel: DECISIONS[decision].en, decisionLabelAr: DECISIONS[decision].ar,
      owner, ownerLabel: OWNERS[owner].en, ownerLabelAr: OWNERS[owner].ar,
      reasonCodes: [...new Set(issues.map((i) => i.code))], issues, invoice: inv,
      vendorName: vendor?.nameEn, vendorNameAr: vendor?.nameAr, vendorVat: vendor?.vat,
      steps, usage: ex.usage, format: ex.format,
    };

    if (decision === 'APPROVED_AUTO' || decision === 'APPROVAL_REQUIRED') {
      result.payment = this.schedule(inv, vendor);
      await this.erp.markProcessed(rid, inv, vendor);
      if (decision === 'APPROVED_AUTO') {
        await this.erp.post(ledgerEntry(rid, inv, vendor, result.payment, 'wazin'));
        const d = result.payment.discount;
        step('post', 'ok',
          `Posted to the ledger. Payment of ${sar(result.payment.amount)} scheduled for ${result.payment.payOn}${d ? `, saving ${sar(d)} with the supplier's early-payment discount` : ''}.`,
          `قُيّدت في الدفاتر وجُدول دفع ${sarAr(result.payment.amount)} بتاريخ ${result.payment.payOn}${d ? `، مع توفير ${sarAr(d)} بخصم الدفع المبكر` : ''}.`);
      } else {
        const lim = await this.erp.approvalLimit();
        step('approval', 'warn',
          `${sar(inv.total)} is above the ${sar(lim)} automatic limit. Every check passed; the Finance Manager can approve with one click.`,
          `${sarAr(inv.total)} أعلى من حد الاعتماد التلقائي ${sarAr(lim)}. اجتازت جميع الفحوصات، ويمكن للمدير المالي اعتمادها بنقرة واحدة.`);
      }
    } else if (decision === 'PARKED') {
      await this.erp.park(rid, doc, inv.poNumber);
      await this.erp.markProcessed(rid, inv, vendor);
      step('park', 'warn',
        `Waiting for the warehouse to record goods for ${inv.poNumber}. Wazin will check again and pay automatically when they do.`,
        `بانتظار تسجيل المستودع لاستلام بضاعة ${inv.poNumber}. سيعيد وازِن الفحص ويدفع تلقائياً عند التسجيل.`);
    } else {
      step('handoff', 'fail',
        `Sent to ${OWNERS[owner].en} with the evidence and a ready-to-send message.`,
        `أُحيلت إلى ${OWNERS[owner].ar} مع الأدلة ورسالة جاهزة للإرسال.`);
    }
    if (owner !== 'NONE') result.message = draftMessage(result, vendor, po);
    result.ms = Math.round((performance.now() - t0) * 100) / 100;
    this.log.push(result);
    return result;
  }
}

/** Ledger line written when an invoice is approved: what was posted, to whom, and when it will be paid. */
export function ledgerEntry(id, inv, vendor, payment, by) {
  return { id, invoiceNumber: inv.invoiceNumber, vendor: vendor?.nameEn, vendorVat: vendor?.vat, poNumber: inv.poNumber,
    amountExVat: inv.subtotal, inputVat: inv.vatAmount, total: inv.total, payAmount: payment.amount, payOn: payment.payOn, postedBy: by };
}

// ---------- Bilingual hand-off messages (deterministic templates: 0 tokens) ----------
/** Draft the ready-to-send note (English and Arabic) for the team or supplier that must act. */
export function draftMessage(r, vendor, po) {
  const inv = r.invoice;
  const ref = `${inv.invoiceNumber ?? '(no number)'} / ${inv.poNumber ?? '(no PO)'}`;
  const list = (arr, key) => arr.map((i) => `• ${i[key]}`).join('\n');
  const comp = r.issues.filter((i) => COMPLIANCE_CODES.includes(i.code));
  const other = r.issues.filter((i) => !COMPLIANCE_CODES.includes(i.code));
  const T = {
    VENDOR: {
      to: vendor?.email || inv.sellerName || 'Supplier',
      subject: `Invoice ${inv.invoiceNumber}: correction needed / تصحيح مطلوب`,
      en: `Dear ${vendor?.nameEn || inv.sellerName},\n\nWe could not process invoice ${inv.invoiceNumber} because it does not meet ZATCA e-invoicing requirements:\n${list(comp, 'message')}${other.length ? `\n\nWe also found:\n${list(other, 'message')}` : ''}\n\nPlease issue a corrected tax invoice (or credit note) through your e-invoicing system. Payment will be released as soon as the corrected invoice passes validation.\n\nAccounts Payable`,
      ar: `السادة ${vendor?.nameAr || inv.sellerName} المحترمين،\n\nتعذّر علينا معالجة الفاتورة رقم ${inv.invoiceNumber} لعدم استيفائها متطلبات الفوترة الإلكترونية لهيئة الزكاة والضريبة والجمارك:\n${list(comp, 'messageAr')}${other.length ? `\n\nووجدنا أيضاً:\n${list(other, 'messageAr')}` : ''}\n\nنرجو إصدار فاتورة ضريبية مصحّحة (أو إشعار دائن)، وسيتم صرف المبلغ فور اجتياز الفاتورة المصحّحة للتحقق.\n\nإدارة الحسابات الدائنة`,
    },
    PROCUREMENT: {
      to: po?.buyer || 'Procurement team',
      subject: `Action needed on ${ref} / إجراء مطلوب`,
      en: `Hello,\n\nInvoice ${inv.invoiceNumber} from ${inv.sellerName} (${sar(inv.total)}) does not match the purchase order:\n${list(r.issues, 'message')}\n\nPlease agree with the supplier whether to amend the purchase order or ask for a credit note, then choose "Amend order" or "Reject invoice" in Wazin.`,
      ar: `مرحباً،\n\nالفاتورة ${inv.invoiceNumber} من ${inv.sellerName} (${sarAr(inv.total)}) لا تطابق أمر الشراء:\n${list(r.issues, 'messageAr')}\n\nنرجو الاتفاق مع المورد على تعديل أمر الشراء أو طلب إشعار دائن، ثم اختيار "تعديل الطلب" أو "رفض الفاتورة" في وازِن.`,
    },
    WAREHOUSE: {
      to: 'Warehouse',
      subject: `Goods receipt check for ${inv.poNumber} / فحص الاستلام`,
      en: `Hello,\n\nWe have invoice ${inv.invoiceNumber} from ${inv.sellerName} for ${inv.poNumber}:\n${list(r.issues, 'message')}\n\nIf the goods have arrived, record the goods receipt in Wazin and it will check again and pay automatically. If the quantities are different, record what actually arrived.`,
      ar: `مرحباً،\n\nلدينا الفاتورة ${inv.invoiceNumber} من ${inv.sellerName} لأمر الشراء ${inv.poNumber}:\n${list(r.issues, 'messageAr')}\n\nإذا وصلت البضاعة فسجّل سند الاستلام في وازِن وسيعيد الفحص ويدفع تلقائياً، وإن اختلفت الكميات فسجّل ما وصل فعلاً.`,
    },
    TREASURY: {
      to: 'Treasury',
      subject: `Payment hold: bank details changed — ${inv.sellerName} / إيقاف دفع`,
      en: `Payment for invoice ${inv.invoiceNumber} (${sar(inv.total)}) is on hold.\n${list(r.issues, 'message')}\n\nDo not use any contact details printed on the invoice. Call the supplier on the number already on file (${vendor?.phone || 'see supplier record'}) to confirm the change. Payment stays blocked until the new account is verified in Wazin.`,
      ar: `دفع الفاتورة ${inv.invoiceNumber} (${sarAr(inv.total)}) موقوف.\n${list(r.issues, 'messageAr')}\n\nلا تستخدم أي بيانات اتصال مطبوعة على الفاتورة. اتصل بالمورد على الرقم المسجّل لدينا (${vendor?.phone || 'انظر سجل المورد'}) لتأكيد التغيير. يبقى الدفع موقوفاً حتى توثيق الحساب الجديد في وازِن.`,
    },
    AP: {
      to: 'Accounts Payable',
      subject: r.decision === 'BLOCKED' ? `Duplicate blocked: ${inv.invoiceNumber} / فاتورة مكررة` : `Data review: ${inv.invoiceNumber ?? 'unreadable invoice'} / مراجعة بيانات`,
      en: r.decision === 'BLOCKED'
        ? `Invoice ${inv.invoiceNumber} from ${inv.sellerName} (${sar(inv.total)}) was blocked:\n${list(r.issues, 'message')}\nNo action is needed unless the supplier disputes it.`
        : `Wazin could not read every required field on this invoice:\n${list(r.issues, 'message')}\nEnter the missing details in Wazin; every other check then runs automatically.`,
      ar: r.decision === 'BLOCKED'
        ? `أُوقفت الفاتورة ${inv.invoiceNumber} من ${inv.sellerName} (${sarAr(inv.total)}):\n${list(r.issues, 'messageAr')}\nلا يلزم أي إجراء إلا إذا اعترض المورد.`
        : `تعذّر على وازِن قراءة جميع الحقول المطلوبة:\n${list(r.issues, 'messageAr')}\nأدخل البيانات الناقصة في وازِن وستكتمل بقية الفحوصات تلقائياً.`,
    },
    FINANCE_MANAGER: {
      to: 'Finance Manager',
      subject: `Approve ${sar(inv.total)} — ${inv.sellerName} (${inv.invoiceNumber}) / طلب اعتماد`,
      en: `Every check passed for invoice ${inv.invoiceNumber} from ${inv.sellerName}:\n• ZATCA compliant (VAT number, 15% VAT, QR code)\n• Matches ${inv.poNumber} and the goods received on every line\n• Not a duplicate; bank account verified\n\nThe amount, ${sar(inv.total)}, is above your automatic limit. Approve it in Wazin to release payment on ${r.payment?.payOn}.`,
      ar: `اجتازت الفاتورة ${inv.invoiceNumber} من ${inv.sellerName} جميع الفحوصات:\n• متوافقة مع متطلبات هيئة الزكاة (الرقم الضريبي، ضريبة ١٥٪، رمز QR)\n• تطابق ${inv.poNumber} والبضاعة المستلمة في كل البنود\n• غير مكررة والحساب البنكي موثّق\n\nالمبلغ ${sarAr(inv.total)} أعلى من حد الاعتماد التلقائي. اعتمدها في وازِن لصرف الدفعة بتاريخ ${r.payment?.payOn}.`,
    },
  }[r.owner];
  return T ? { to: T.to, subject: T.subject, bodyEn: T.en, bodyAr: T.ar } : undefined;
}
