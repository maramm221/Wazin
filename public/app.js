// Wazin web app. Plain JavaScript modules, no build step, no third-party code.
// All user data is inserted with textContent (never innerHTML), so it cannot run as script.
import { STRINGS, ACTION_LABELS } from './i18n.js';

// ---------------------------------------------------------------- state & helpers
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: fine */ } },
};
const state = {
  lang: store.get('wz_lang') || ((navigator.language || '').toLowerCase().startsWith('ar') ? 'ar' : 'en'),
  me: null, csrf: '', config: { signup: true, demo: true, ai: false },
};

function t(key, vars = {}) {
  const v = STRINGS[state.lang][key] ?? STRINGS.en[key] ?? key;
  return typeof v === 'string' ? v.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '') : v;
}
const isAr = () => state.lang === 'ar';
const pick = (en, ar) => (isAr() && ar ? ar : en);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM: allowed under the strict CSP
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const money = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const whole = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const when = (ts) => new Date(ts).toLocaleString(isAr() ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });

const STATUS_TONE = { APPROVED_AUTO: 'ok', APPROVED: 'ok', APPROVAL_REQUIRED: 'info', PARKED: 'wait', EXCEPTION: 'warn', BLOCKED: 'crit', REVIEW: 'neutral', REJECTED: 'neutral', CLOSED: 'neutral' };
const pill = (status) => h('span', { class: `pill tone-${STATUS_TONE[status] || 'neutral'}`, text: t(`st_${status}`) });

// ---------------------------------------------------------------- API
class ApiError extends Error {
  constructor(code, status, detail) { super(code); this.code = code; this.status = status; this.detail = detail; }
}
async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(state.csrf ? { 'X-CSRF-Token': state.csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('network', 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const code = data?.error || 'unknown';
    if (res.status === 401 && code === 'not_signed_in' && state.me) {
      state.me = null; state.csrf = '';
      toast(t('e_not_signed_in'), 'warn');
      go('#/welcome');
    }
    throw new ApiError(code, res.status, data?.detail);
  }
  return data;
}
function errText(e) {
  if (!(e instanceof ApiError)) return t('e_unknown');
  if (e.code === 'missing_columns') return t('e_missing_columns', { cols: (e.detail?.missing || []).join(', ') });
  const k = `e_${e.code}`;
  return STRINGS.en[k] ? t(k) : t('e_unknown');
}

// ---------------------------------------------------------------- toasts
function toast(msg, kind = 'ok') {
  const box = document.getElementById('toasts');
  const el = h('div', { class: `toast toast-${kind}`, role: kind === 'crit' ? 'alert' : 'status' }, msg);
  box.append(el);
  setTimeout(() => el.classList.add('out'), 4200);
  setTimeout(() => el.remove(), 4700);
}

// ---------------------------------------------------------------- language
function applyLang() {
  document.documentElement.lang = state.lang;
  document.documentElement.dir = isAr() ? 'rtl' : 'ltr';
  document.title = `${t('app_name')} · ${t('tagline')}`;
}
function toggleLang() {
  state.lang = isAr() ? 'en' : 'ar';
  store.set('wz_lang', state.lang);
  applyLang();
  render();
}
const langButton = () => h('button', { class: 'lang', type: 'button', onclick: toggleLang, 'aria-label': t('lang_switch_label'), lang: isAr() ? 'en' : 'ar' }, h('span', { class: 'globe', 'aria-hidden': 'true' }), t('lang_switch'));

// ---------------------------------------------------------------- brand
const mark = (size = 34) => {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 40 40'); s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', 'mark');
  const r = document.createElementNS(ns, 'rect'); r.setAttribute('width', 40); r.setAttribute('height', 40); r.setAttribute('rx', 10); r.setAttribute('class', 'mark-bg'); s.append(r);
  [11, 18, 25].forEach((y, i) => { const b = document.createElementNS(ns, 'rect'); b.setAttribute('x', 9); b.setAttribute('y', y); b.setAttribute('width', 22); b.setAttribute('height', 4); b.setAttribute('rx', 2); b.setAttribute('class', i ? 'mark-bar' : 'mark-bar top'); s.append(b); });
  return s;
};
const brand = () => h('a', { href: '#/home', class: 'brand' }, mark(), h('span', { class: 'brand-name' }, h('b', { text: 'Wazin' }), h('span', { class: 'brand-ar', lang: 'ar', text: 'وازِن' })));

// ---------------------------------------------------------------- router
const app = document.getElementById('app');
function go(hash) { if (location.hash !== hash) location.hash = hash; else render(); }
function route() {
  const [, page = 'home', id] = (location.hash || '#/home').replace(/^#/, '').split('/');
  return { page, id: id ? decodeURIComponent(id) : undefined };
}
let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  applyLang();
  const { page, id } = route();
  const publicPages = { welcome: pageWelcome, signin: pageSignin, signup: pageSignup };
  if (!state.me && !publicPages[page]) {
    try { await loadMe(); } catch { /* not signed in */ }
    if (seq !== renderSeq) return;
    if (!state.me) return go('#/welcome');
  }
  if (publicPages[page]) {
    if (state.me) return go('#/home');
    app.replaceChildren(publicPages[page]());
    focusMain();
    return;
  }
  const pages = { home: pageHome, invoices: pageInvoices, invoice: pageInvoice, new: pageNew, orders: pageOrders, suppliers: pageSuppliers, activity: pageActivity, settings: pageSettings };
  const fn = pages[page] || pageHome;
  const main = h('main', { id: 'main', tabindex: '-1', class: 'main' }, h('div', { class: 'loading', role: 'status' }, t('loading')));
  app.replaceChildren(shell(page, main));
  try {
    const content = await fn(id);
    if (seq !== renderSeq) return;
    main.replaceChildren(content);
  } catch (e) {
    if (seq !== renderSeq) return;
    main.replaceChildren(h('div', { class: 'empty' }, h('p', { text: errText(e) }), h('button', { class: 'btn', type: 'button', onclick: render, text: t('retry') })));
  }
  focusMain();
}
function focusMain() { const m = document.getElementById('main'); if (m) m.focus({ preventScroll: true }); window.scrollTo(0, 0); }
async function loadMe() {
  const me = await api('GET', '/api/me');
  state.me = me; state.csrf = me.csrf;
}
addEventListener('hashchange', render);

// ---------------------------------------------------------------- shell
const NAV = [
  ['home', 'nav_home', 'M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z'],
  ['invoices', 'nav_invoices', 'M6 2h9l5 5v15H6zM14 2v6h6M9 13h8M9 17h8'],
  ['new', 'nav_new', 'M12 5v14M5 12h14'],
  ['orders', 'nav_orders', 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10'],
  ['suppliers', 'nav_suppliers', 'M3 21V8l6-4 6 4v13M15 21V11l6 3v7M7 10h4M7 14h4M7 18h4'],
  ['activity', 'nav_activity', 'M4 12h4l3-8 4 16 3-8h2'],
  ['settings', 'nav_settings', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z'],
];
function icon(d) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', 20); s.setAttribute('height', 20); s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', 'ico');
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); s.append(p);
  return s;
}
function navItems() {
  return NAV.filter(([k]) => k !== 'settings' || state.me.user.role === 'admin');
}
function shell(current, main) {
  const { user, org } = state.me;
  const sandbox = org.kind === 'sandbox';
  const roleSel = sandbox ? h('label', { class: 'viewas' }, h('span', { text: t('viewing_as') }),
    h('select', { id: 'viewas', onchange: async (e) => {
      try {
        const r = await api('POST', '/api/sandbox/switch', { role: e.target.value });
        state.csrf = r.csrf;
        await loadMe();
        go('#/home');
        render();
      } catch (err) { toast(errText(err), 'crit'); }
    } }, ['ap', 'finance', 'procurement', 'warehouse', 'treasury', 'admin'].map((r) => h('option', { value: r, selected: r === user.role, text: t(`role_${r}`) })))) : h('span', { class: 'who' }, h('b', { text: user.name }), h('span', { text: t(`role_${user.role}`) }));
  const signOut = h('button', { class: 'btn ghost small', type: 'button', onclick: async () => { try { await api('POST', '/api/logout', {}); } catch { /* already gone */ } state.me = null; state.csrf = ''; go('#/welcome'); }, text: t('sign_out') });

  const top = h('header', { class: 'topbar' },
    h('div', { class: 'topbar-in' },
      brand(),
      h('span', { class: 'org' }, org.name, sandbox ? h('span', { class: 'badge', text: t('demo_badge') }) : null),
      h('div', { class: 'spacer' }),
      langButton(),
      h('span', { class: 'hide-sm' }, roleSel),
      h('span', { class: 'hide-sm' }, signOut)));

  const items = navItems();
  const side = h('nav', { class: 'sidenav', 'aria-label': 'Main' }, items.map(([k, label, d]) =>
    h('a', { href: `#/${k}`, class: current === k || (k === 'invoices' && current === 'invoice') ? 'active' : '', 'aria-current': current === k ? 'page' : null }, icon(d), h('span', { text: t(label) }))));

  // Mobile: four main tabs plus "More".
  const moreSheet = h('div', { class: 'sheet', hidden: true, id: 'more' },
    h('div', { class: 'sheet-card' },
      items.slice(4).map(([k, label, d]) => h('a', { href: `#/${k}`, onclick: () => (moreSheet.hidden = true) }, icon(d), h('span', { text: t(label) }))),
      h('button', { class: 'sheet-signout', type: 'button', onclick: () => signOut.click(), text: t('sign_out') })));
  moreSheet.addEventListener('click', (e) => { if (e.target === moreSheet) moreSheet.hidden = true; });
  const bottom = h('nav', { class: 'bottomnav', 'aria-label': 'Main' },
    items.slice(0, 4).map(([k, label, d]) => h('a', { href: `#/${k}`, class: current === k || (k === 'invoices' && current === 'invoice') ? 'active' : '' }, icon(d), h('span', { text: t(label) }))),
    h('button', { type: 'button', class: ['suppliers', 'activity', 'settings'].includes(current) ? 'active' : '', onclick: () => (moreSheet.hidden = !moreSheet.hidden), 'aria-expanded': 'false' }, icon('M4 6h16M4 12h16M4 18h16'), h('span', { text: t('nav_more') })));

  const banner = sandbox ? h('div', { class: 'demo-banner', role: 'note' }, h('div', { class: 'wrap banner-in' }, h('span', { text: t('demo_banner') }), h('span', { class: 'show-sm' }, roleSel.cloneNode(true)))) : null;
  if (banner) { const sel = banner.querySelector('select'); sel.id = 'viewas_sm'; sel.value = user.role; sel.onchange = roleSel.querySelector('select').onchange; }
  return h('div', { class: 'layout' }, top, banner, h('div', { class: 'body wrap' }, side, main), bottom, moreSheet,
    h('footer', { class: 'foot wrap', text: t('footer') }));
}

// ---------------------------------------------------------------- public pages
function publicFrame(...content) {
  return h('div', { class: 'public' },
    h('header', { class: 'pub-top wrap' }, h('a', { href: '#/welcome', class: 'brand' }, mark(), h('span', { class: 'brand-name' }, h('b', { text: 'Wazin' }), h('span', { class: 'brand-ar', lang: 'ar', text: 'وازِن' }))), h('div', { class: 'spacer' }), langButton()),
    h('main', { id: 'main', tabindex: '-1', class: 'pub-main wrap' }, ...content),
    h('footer', { class: 'foot wrap', text: t('footer') }));
}

function pageWelcome() {
  const demoBtn = h('button', { class: 'btn primary big', type: 'button' }, t('try_demo'));
  const status = h('p', { class: 'muted small', role: 'status' }, t('try_demo_note'));
  demoBtn.onclick = async () => {
    demoBtn.disabled = true;
    status.textContent = t('creating_demo');
    try {
      const r = await api('POST', '/api/sandbox', { lang: state.lang });
      state.csrf = r.csrf;
      await loadMe();
      go('#/home');
    } catch (e) {
      status.textContent = errText(e);
      demoBtn.disabled = false;
    }
  };
  const steps = [1, 2, 3].map((n) => h('li', { class: 'how' }, h('span', { class: 'how-n', text: String(n) }), h('div', {}, h('h3', { text: t(`how_${n}_t`) }), h('p', { text: t(`how_${n}_d`) }))));
  return publicFrame(
    h('section', { class: 'hero' },
      h('h1', { text: t('welcome_title') }),
      h('p', { class: 'lead', text: t('welcome_lead') }),
      h('div', { class: 'cta' }, state.config.demo ? demoBtn : null, h('a', { class: 'btn big', href: '#/signin', text: t('sign_in') })),
      state.config.demo ? status : null),
    h('ol', { class: 'hows' }, steps),
    state.config.signup ? h('p', { class: 'center' }, t('no_account'), ' ', h('a', { href: '#/signup', text: t('create_workspace') })) : null);
}

function formField(label, input, help) {
  const id = input.id || `f_${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  return h('div', { class: 'field' }, h('label', { for: id, text: label }), input, help ? h('p', { class: 'help', text: help }) : null);
}
function formError() { return h('p', { class: 'form-error', role: 'alert', hidden: true }); }
function showErr(el, e) { el.textContent = typeof e === 'string' ? e : errText(e); el.hidden = false; }

function pageSignin() {
  const em = h('input', { type: 'email', autocomplete: 'username', required: true, id: 'si_email' });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true, id: 'si_pw' });
  const err = formError();
  const btn = h('button', { class: 'btn primary', type: 'submit', text: t('sign_in') });
  const form = h('form', { class: 'card form narrow', novalidate: true }, h('h1', { text: t('signin_title') }), formField(t('email'), em), formField(t('password'), pw), err, btn,
    state.config.signup ? h('p', { class: 'muted small' }, t('no_account'), ' ', h('a', { href: '#/signup', text: t('create_workspace') })) : null);
  form.onsubmit = async (e) => {
    e.preventDefault();
    err.hidden = true; btn.disabled = true;
    try {
      const r = await api('POST', '/api/login', { email: em.value, password: pw.value });
      state.csrf = r.csrf;
      await loadMe();
      go('#/home');
    } catch (x) { showErr(err, x); btn.disabled = false; pw.value = ''; pw.focus(); }
  };
  return publicFrame(form);
}

function pageSignup() {
  const co = h('input', { type: 'text', autocomplete: 'organization', required: true, maxlength: 120 });
  const nm = h('input', { type: 'text', autocomplete: 'name', required: true, maxlength: 120 });
  const em = h('input', { type: 'email', autocomplete: 'email', required: true });
  const pw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 10 });
  const err = formError();
  const btn = h('button', { class: 'btn primary', type: 'submit', text: t('create_workspace') });
  const form = h('form', { class: 'card form narrow', novalidate: true }, h('h1', { text: t('signup_title') }), h('p', { class: 'muted', text: t('signup_note') }),
    formField(t('company'), co), formField(t('full_name'), nm), formField(t('email'), em), formField(t('password'), pw, t('password_rule')), err, btn,
    h('p', { class: 'muted small' }, t('have_account'), ' ', h('a', { href: '#/signin', text: t('sign_in') })));
  form.onsubmit = async (e) => {
    e.preventDefault();
    err.hidden = true; btn.disabled = true;
    try {
      const r = await api('POST', '/api/signup', { company: co.value, name: nm.value, email: em.value, password: pw.value });
      state.csrf = r.csrf;
      await loadMe();
      go('#/settings');
    } catch (x) { showErr(err, x); btn.disabled = false; }
  };
  return publicFrame(form);
}

// ---------------------------------------------------------------- home
async function pageHome() {
  const d = await api('GET', '/api/dashboard');
  const { user } = state.me;
  const guide = t(`guide_${user.role}`);
  const kpis = [
    ['kpi_auto', whole(d.paidAutomatically), 'kpi_auto_sub', 'ok'],
    ['kpi_waiting', whole(d.waiting), 'kpi_waiting_sub', 'warn'],
    ['kpi_stopped', whole(d.stoppedAmount), 'kpi_stopped_sub', 'crit'],
    ['kpi_discounts', money(d.discounts), 'kpi_discounts_sub', 'ok'],
  ];
  const ownersOrder = ['FINANCE_MANAGER', 'PROCUREMENT', 'WAREHOUSE', 'TREASURY', 'VENDOR', 'AP'];
  return h('div', { class: 'stack' },
    h('div', { class: 'page-head' }, h('h1', { text: t('hello', { name: user.name.split(' ')[0] }) }), h('p', { class: 'muted', text: t('signed_in_as', { role: t(`role_${user.role}`) }) })),
    h('section', { class: 'card guide', 'aria-labelledby': 'g_h' }, h('h2', { id: 'g_h', text: t('next_steps') }), h('ol', {}, guide.map((s) => h('li', { text: s })))),
    h('section', { class: 'kpis', 'aria-label': 'Summary' }, kpis.map(([k, v, sub, tone]) => h('div', { class: `kpi tone-${tone}` }, h('span', { class: 'kpi-label', text: t(k) }), h('span', { class: 'kpi-val', text: v }), h('span', { class: 'kpi-sub', text: t(sub) })))),
    h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { text: t('your_tasks') }), h('span', { class: 'count', text: String(d.myTasks.length) })),
      d.myTasks.length ? invoiceList(d.myTasks) : h('p', { class: 'empty-inline', text: t('no_tasks') })),
    h('section', { class: 'card' }, h('h2', { text: t('team_overview') }),
      h('ul', { class: 'owners' }, ownersOrder.map((o) => h('li', {}, h('span', { text: t(`ow_${o}`) }), h('b', { class: d.byOwner[o] ? 'has' : '', text: String(d.byOwner[o] || 0) }))))));
}

function invoiceList(rows) {
  return h('ul', { class: 'inv-list' }, rows.map((r) => h('li', {},
    h('a', { href: `#/invoice/${encodeURIComponent(r.id)}`, class: `inv-row tone-${STATUS_TONE[r.status]}` },
      h('span', { class: 'inv-main' }, h('b', { text: r.vendorName || t('unreadable') }), h('span', { class: 'muted small', text: `${r.invoiceNumber || r.id} · ${r.poNumber || '—'}` })),
      h('span', { class: 'inv-amt num', text: money(r.total) }),
      h('span', { class: 'inv-state' }, pill(r.status), r.owner !== 'NONE' ? h('span', { class: 'muted small', text: t(`ow_${r.owner}`) }) : null)))));
}

// ---------------------------------------------------------------- invoices
const FILTERS = { all: {}, open: { statuses: ['APPROVAL_REQUIRED', 'PARKED', 'EXCEPTION', 'BLOCKED', 'REVIEW'] }, paid: { statuses: ['APPROVED_AUTO', 'APPROVED'] }, blocked: { statuses: ['BLOCKED'] }, rejected: { statuses: ['REJECTED', 'CLOSED'] } };
let invFilter = 'all', invQuery = '';
async function pageInvoices() {
  const rows = await api('GET', `/api/invoices?limit=500${invQuery ? `&q=${encodeURIComponent(invQuery)}` : ''}`);
  const listBox = h('div', {});
  const draw = () => {
    const f = FILTERS[invFilter];
    const shown = f.statuses ? rows.filter((r) => f.statuses.includes(r.status)) : rows;
    listBox.replaceChildren(shown.length ? invoiceList(shown) : h('p', { class: 'empty-inline', text: t('no_invoices') }));
    chips.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === invFilter)));
  };
  const chips = h('div', { class: 'chips', role: 'group' }, Object.keys(FILTERS).map((k) => {
    const n = FILTERS[k].statuses ? rows.filter((r) => FILTERS[k].statuses.includes(r.status)).length : rows.length;
    return h('button', { type: 'button', 'data-f': k, onclick: () => { invFilter = k; draw(); } }, t(`f_${k}`), h('span', { class: 'chip-n', text: String(n) }));
  }));
  const q = h('input', { type: 'search', placeholder: t('search'), value: invQuery, 'aria-label': t('search') });
  let timer;
  q.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { invQuery = q.value.trim(); render(); }, 350); };
  draw();
  return h('div', { class: 'stack' }, h('div', { class: 'page-head row' }, h('h1', { text: t('invoices_title') }), h('a', { class: 'btn primary', href: '#/new', text: t('nav_new') })),
    q, chips, h('section', { class: 'card flush' }, listBox));
}

// ---------------------------------------------------------------- invoice detail
async function pageInvoice(id) {
  const v = await api('GET', `/api/invoices/${encodeURIComponent(id)}`);
  const r = v.result;
  const inv = r.invoice || {};
  const fresh = sessionStorage?.getItem?.('wz_fresh') === v.id;
  try { sessionStorage.removeItem('wz_fresh'); } catch { /* ignore */ }
  const nextKey = v.status === 'EXCEPTION' ? `next_EXCEPTION_${v.owner}` : v.status === 'BLOCKED' ? `next_BLOCKED_${v.owner}` : `next_${v.status}`;

  const head = h('div', { class: 'page-head' },
    h('a', { href: '#/invoices', class: 'back' }, t('back')),
    h('h1', { text: pick(r.vendorName || inv.sellerName, r.vendorNameAr) || t('unreadable') }),
    h('p', { class: 'muted' }, `${inv.invoiceNumber || '—'} · ${v.id}`, ' · ', h('span', { class: 'num', text: `${t('sar')} ${money(inv.total)}` })));

  const verdict = h('section', { class: `verdict tone-${STATUS_TONE[v.status]}` },
    h('div', {}, pill(v.status), v.owner !== 'NONE' ? h('span', { class: 'owner', text: `→ ${t(`ow_${v.owner}`)}` }) : null),
    h('h2', { text: t('what_happened') }),
    r.issues.length ? h('ul', { class: 'issues' }, r.issues.map((i) => h('li', { text: pick(i.message, i.messageAr) })))
      : h('p', { text: pick(r.steps.at(-1)?.detail, r.steps.at(-1)?.detailAr) }),
    h('h2', { text: t('what_next') }), h('p', { text: t(nextKey) }));

  const actions = actionPanel(v);
  const checks = h('section', { class: 'card' }, h('h2', { text: t('checks') }),
    h('ol', { class: `steps${fresh ? ' animate' : ''}` }, r.steps.map((s, i) => h('li', { class: `st-${s.status}`, style: `--i:${i}` },
      h('span', { class: 'dot', 'aria-hidden': 'true', text: s.status === 'ok' ? '✓' : s.status === 'warn' ? '•' : '!' }),
      h('div', {}, h('b', { text: pick(s.name, s.nameAr) }), h('span', { class: 'sr', text: ` (${t(`step_${s.status}`)})` }), h('p', { text: pick(s.detail, s.detailAr) }))))));

  const details = h('section', { class: 'card' }, h('h2', { text: t('the_invoice') }),
    h('dl', { class: 'facts' },
      [[t('issued'), inv.issueDate], [t('po'), inv.poNumber], [t('vendor_vat'), inv.sellerVat], [t('total'), `${t('sar')} ${money(inv.total)}`],
        r.payment ? [t('pay_on'), r.payment.payOn] : null, r.payment?.discount ? [t('discount'), `${t('sar')} ${money(r.payment.discount)}`] : null]
        .filter(Boolean).map(([k, val]) => h('div', {}, h('dt', { text: k }), h('dd', { class: 'num', text: val || '—' })))),
    inv.lines?.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, [t('item'), t('qty'), t('unit_price'), t('amount')].map((x, i) => h('th', { class: i ? 'num' : '', text: x })))),
      h('tbody', {}, inv.lines.map((l) => h('tr', {}, h('td', {}, h('span', { text: l.name }), h('br'), h('span', { class: 'muted small', text: l.sku || '' })), h('td', { class: 'num', text: String(l.qty) }), h('td', { class: 'num', text: money(l.unitPrice) }), h('td', { class: 'num', text: money(l.qty * l.unitPrice) })))),
      h('tfoot', {}, [[t('subtotal'), inv.subtotal], [t('vat'), inv.vatAmount], [t('total'), inv.total]].map(([k, val]) => h('tr', {}, h('th', { colspan: 3, text: k }), h('td', { class: 'num', text: money(val) }))))))
      : null);

  const msg = r.message ? messageCard(r.message) : null;
  const hist = h('section', { class: 'card' }, h('h2', { text: t('history') }),
    h('ul', { class: 'timeline' }, v.audit.map((a) => h('li', {}, h('span', { class: 'muted small', text: when(a.ts) }), h('span', { text: ACTION_LABELS[state.lang][a.action] || a.action }), h('span', { class: 'muted small', text: a.actorName || a.actor })))));
  const orig = h('details', { class: 'card' }, h('summary', { text: t('original') }), h('pre', { class: 'doc', text: v.doc }));

  return h('div', { class: 'detail' }, head, h('div', { class: 'detail-grid' },
    h('div', { class: 'stack' }, verdict, actions, msg),
    h('div', { class: 'stack' }, checks, details, hist, orig)));
}

function messageCard(m) {
  let lang = state.lang;
  const body = h('pre', { class: 'msg-body' });
  const set = (l) => {
    lang = l;
    body.textContent = l === 'ar' ? m.bodyAr : m.bodyEn;
    body.dir = l === 'ar' ? 'rtl' : 'ltr';
    bEn.setAttribute('aria-pressed', String(l === 'en')); bAr.setAttribute('aria-pressed', String(l === 'ar'));
  };
  const bEn = h('button', { type: 'button', onclick: () => set('en'), text: 'English' });
  const bAr = h('button', { type: 'button', onclick: () => set('ar'), text: 'العربية', lang: 'ar' });
  const copy = h('button', { class: 'btn small', type: 'button', text: t('copy') });
  copy.onclick = async () => {
    const text = `${m.subject}\n\n${lang === 'ar' ? m.bodyAr : m.bodyEn}`;
    try { await navigator.clipboard.writeText(text); toast(t('copied')); } catch { getSelection().selectAllChildren(body); toast(t('select_copy'), 'warn'); }
  };
  set(lang);
  return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { text: t('message_draft') }), h('div', { class: 'seg' }, bEn, bAr)),
    h('p', { class: 'muted small' }, `${t('to')}: `, h('span', { text: m.to })), h('p', { class: 'msg-subject', text: m.subject }), body, copy);
}

// ---------- actions
function actionPanel(v) {
  if (!v.actions.length) {
    if (['APPROVED_AUTO', 'APPROVED', 'REJECTED', 'CLOSED'].includes(v.status)) return null;
    return h('section', { class: 'card muted-card' }, h('p', { text: t('not_your_action', { owner: t(`ow_${v.owner}`) }) }));
  }
  const area = h('div', {});
  const buttons = h('div', { class: 'action-buttons' }, v.actions.map((a) => h('button', {
    type: 'button', class: `btn ${['approve', 'verify_bank', 'amend_po', 'record_receipt', 'resubmit', 'add_vendor', 'manual_entry'].includes(a) && a === v.actions[0] ? 'primary' : a === 'reject' ? 'danger-ghost' : ''}`,
    onclick: () => { area.replaceChildren(actionForm(v, a, () => area.replaceChildren())); area.querySelector('input,textarea,select,button')?.focus(); },
    text: t(`a_${a}`),
  })));
  return h('section', { class: 'card action-card', 'aria-labelledby': 'act_h' }, h('h2', { id: 'act_h', text: t('your_action') }), buttons, area);
}

function actionForm(v, action, close) {
  const r = v.result, inv = r.invoice || {};
  const err = formError();
  const fields = [];
  const get = {};
  const note = (required) => {
    const ta = h('textarea', { rows: 2, maxlength: 500, required });
    fields.push(formField(required ? t('reason') : t('note_optional'), ta));
    get.note = () => ta.value;
  };
  if (action === 'approve' || action === 'close' || action === 'amend_po') note(false);
  if (action === 'reject') note(true);
  if (action === 'verify_bank') {
    const vend = v.vendor || {};
    fields.push(h('dl', { class: 'facts compact' },
      h('div', {}, h('dt', { text: t('old_account') }), h('dd', { class: 'num', text: vend.ibanMasked || '—' })),
      h('div', {}, h('dt', { text: t('new_account') }), h('dd', { class: 'num', text: inv.iban || '—' })),
      h('div', {}, h('dt', { text: t('call_number') }), h('dd', { class: 'num', text: vend.phone || '—' }))));
    const cb = h('input', { type: 'checkbox', id: 'confirm_called' });
    fields.push(h('label', { class: 'check', for: 'confirm_called' }, cb, h('span', { text: t('confirm_called') })));
    get.confirmCalled = () => cb.checked;
    note(true);
  }
  if (action === 'add_vendor') {
    const en = h('input', { type: 'text', value: inv.sellerName || '', maxlength: 120 });
    const ar = h('input', { type: 'text', maxlength: 120, dir: 'rtl' });
    const ib = h('input', { type: 'text', value: inv.iban || '', maxlength: 34, inputmode: 'text', autocomplete: 'off' });
    const ph = h('input', { type: 'tel', maxlength: 40 });
    const em = h('input', { type: 'email', maxlength: 254 });
    fields.push(formField(t('name_en'), en), formField(t('name_ar'), ar), formField(t('iban'), ib), formField(t('phone_on_file'), ph), formField(t('supplier_email'), em));
    Object.assign(get, { nameEn: () => en.value, nameAr: () => ar.value, iban: () => ib.value, phone: () => ph.value, email: () => em.value });
    note(false);
  }
  if (action === 'record_receipt') {
    const po = v.po;
    const inputs = (po?.lines || []).map((l) => {
      const remaining = Math.max(0, l.qty - (l.received || 0));
      const inp = h('input', { type: 'number', min: 0, step: 1, value: remaining, inputmode: 'numeric' });
      fields.push(h('div', { class: 'qty-row' }, h('div', {}, h('b', { text: l.name }), h('p', { class: 'muted small', text: `${t('ordered')}: ${l.qty} · ${t('already_received')}: ${l.received || 0}` })), formField(t('received_qty'), inp)));
      return [l.sku, inp];
    });
    get.lines = () => inputs.map(([sku, inp]) => ({ sku, qty: Number(inp.value) }));
    note(false);
  }
  if (action === 'resubmit') {
    const ta = h('textarea', { rows: 8, class: 'mono', spellcheck: 'false' });
    const file = fileInput((text) => { ta.value = text; }, err);
    fields.push(file, formField(t('paste_corrected'), ta));
    get.doc = () => ta.value;
    note(false);
  }
  if (action === 'manual_entry') {
    const mk = (k, label, type = 'text', val = '') => { const i = h('input', { type, value: val ?? '', step: type === 'number' ? '0.01' : null }); fields.push(formField(label, i)); get[k] = () => i.value; };
    mk('invoiceNumber', t('col_invoice'), 'text', inv.invoiceNumber);
    mk('issueDate', t('issued'), 'date', inv.issueDate);
    mk('sellerName', t('col_supplier'), 'text', inv.sellerName);
    mk('sellerVat', t('vat_number'), 'text', inv.sellerVat);
    mk('poNumber', t('po'), 'text', inv.poNumber);
    mk('iban', t('iban'), 'text', inv.iban);
    const linesBox = h('div', { class: 'lines-edit' });
    const addLine = (l = {}) => {
      const sku = h('input', { type: 'text', value: l.sku || '', 'aria-label': t('sku'), placeholder: t('sku') });
      const nm = h('input', { type: 'text', value: l.name || '', 'aria-label': t('item'), placeholder: t('item') });
      const q = h('input', { type: 'number', min: 0, step: 1, value: l.qty ?? '', 'aria-label': t('qty'), placeholder: t('qty') });
      const p = h('input', { type: 'number', min: 0, step: '0.01', value: l.unitPrice ?? '', 'aria-label': t('unit_price'), placeholder: t('unit_price') });
      linesBox.append(h('div', { class: 'line-row' }, sku, nm, q, p));
    };
    (inv.lines?.length ? inv.lines : [{}]).forEach(addLine);
    fields.push(h('fieldset', {}, h('legend', { text: t('lines') }), linesBox, h('button', { type: 'button', class: 'btn small', onclick: () => addLine(), text: '+' })));
    get.lines = () => [...linesBox.children].map((row) => { const [a, b, c, d] = row.querySelectorAll('input'); return { sku: a.value, name: b.value, qty: Number(c.value), unitPrice: Number(d.value) }; }).filter((l) => l.name || l.sku);
    mk('subtotal', t('subtotal'), 'number', inv.subtotal);
    mk('vatAmount', t('vat'), 'number', inv.vatAmount);
    mk('total', t('total'), 'number', inv.total);
    mk('qr', 'QR', 'text', inv.qr);
  }
  const submit = h('button', { class: `btn ${action === 'reject' ? 'danger' : 'primary'}`, type: 'submit', text: t('confirm') });
  const form = h('form', { class: 'action-form', novalidate: true }, h('h3', { text: t(`a_${action}`) }), fields, err,
    h('div', { class: 'row' }, submit, h('button', { class: 'btn ghost', type: 'button', onclick: close, text: t('cancel') })));
  form.onsubmit = async (e) => {
    e.preventDefault();
    err.hidden = true; submit.disabled = true;
    const body = Object.fromEntries(Object.entries(get).map(([k, f]) => [k, f()]));
    try {
      await api('POST', `/api/invoices/${encodeURIComponent(v.id)}/${action}`, body);
      try { sessionStorage.setItem('wz_fresh', v.id); } catch { /* ignore */ }
      toast(t('done_toast'));
      render();
    } catch (x) { showErr(err, x); submit.disabled = false; }
  };
  return form;
}

function fileInput(onText, errEl) {
  const inp = h('input', { type: 'file', accept: '.xml,.txt,text/xml,application/xml,text/plain', class: 'visually-hidden', id: `file_${Math.random().toString(36).slice(2, 8)}` });
  const zone = h('label', { class: 'drop', for: inp.id }, h('b', { text: t('drop') }), h('span', { class: 'muted small', text: t('drop_types') }), inp);
  const read = (file) => {
    if (!file) return;
    if (file.size > 500 * 1024) return showErr(errEl, t('file_too_big'));
    if (!/\.(xml|txt)$/i.test(file.name) && !/^(text\/|application\/xml)/.test(file.type)) return showErr(errEl, t('file_type'));
    const fr = new FileReader();
    fr.onload = () => { errEl.hidden = true; onText(String(fr.result)); zone.querySelector('b').textContent = file.name; };
    fr.readAsText(file);
  };
  inp.onchange = () => read(inp.files[0]);
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); read(e.dataTransfer.files[0]); });
  return zone;
}

// ---------------------------------------------------------------- new invoice
async function pageNew() {
  const err = formError();
  const ta = h('textarea', { rows: 10, class: 'mono', spellcheck: 'false', id: 'new_doc' });
  const zone = fileInput((text) => (ta.value = text), err);
  const btn = h('button', { class: 'btn primary big', type: 'submit', text: t('check_invoice') });
  const status = h('p', { class: 'muted', role: 'status' });
  const form = h('form', { class: 'card form', novalidate: true }, zone, formField(t('or_paste'), ta), err, h('div', { class: 'row' }, btn, status));
  form.onsubmit = async (e) => {
    e.preventDefault();
    err.hidden = true; btn.disabled = true; status.textContent = t('checking');
    try {
      const v = await api('POST', '/api/invoices', { doc: ta.value });
      try { sessionStorage.setItem('wz_fresh', v.id); } catch { /* ignore */ }
      go(`#/invoice/${encodeURIComponent(v.id)}`);
    } catch (x) { showErr(err, x); btn.disabled = false; status.textContent = ''; }
  };
  const canUpload = ['ap', 'admin'].includes(state.me.user.role);
  let samples = [];
  if (state.me.org.kind === 'sandbox') { try { samples = await api('GET', '/api/samples'); } catch { /* optional */ } }
  return h('div', { class: 'stack' },
    h('div', { class: 'page-head' }, h('h1', { text: t('new_title') }), h('p', { class: 'muted', text: t('new_lead') })),
    canUpload ? form : h('p', { class: 'card muted-card', text: t('e_forbidden') }),
    canUpload && samples.length ? h('section', { class: 'card' }, h('h2', { text: t('samples') }),
      h('ul', { class: 'samples' }, samples.map((s) => h('li', {}, h('div', {}, h('b', { text: `${pick(s.vendor, s.vendorAr)} · ${pick(s.label, s.labelAr)}` }), h('p', { class: 'muted small', text: pick(s.story, s.storyAr) })),
        h('button', { class: 'btn small', type: 'button', onclick: () => { ta.value = s.doc; ta.scrollIntoView({ behavior: 'smooth', block: 'center' }); ta.focus(); }, text: t('use_sample') }))))) : null);
}

// ---------------------------------------------------------------- orders
async function pageOrders() {
  const [pos, sup] = await Promise.all([api('GET', '/api/purchase-orders'), api('GET', '/api/suppliers')]);
  const names = Object.fromEntries(sup.map((s) => [s.vat, pick(s.nameEn, s.nameAr)]));
  const canRecord = ['warehouse', 'admin'].includes(state.me.user.role);
  const card = (p) => {
    const ord = p.lines.reduce((s, l) => s + l.qty, 0), rec = p.lines.reduce((s, l) => s + Math.min(l.received, l.qty), 0);
    const pct = ord ? Math.round((rec / ord) * 100) : 0;
    const area = h('div', {});
    const form = () => {
      const err = formError();
      const inputs = p.lines.map((l) => { const i = h('input', { type: 'number', min: 0, step: 1, inputmode: 'numeric', value: Math.max(0, l.qty - l.received) }); return [l, i]; });
      const f = h('form', { class: 'action-form', novalidate: true },
        inputs.map(([l, i]) => h('div', { class: 'qty-row' }, h('div', {}, h('b', { text: l.name }), h('p', { class: 'muted small', text: `${t('ordered')}: ${l.qty} · ${t('already_received')}: ${l.received}` })), formField(t('received_qty'), i))),
        err, h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit', text: t('save_receipt') }), h('button', { class: 'btn ghost', type: 'button', onclick: () => area.replaceChildren(), text: t('cancel') })));
      f.onsubmit = async (e) => {
        e.preventDefault();
        err.hidden = true;
        try {
          const r = await api('POST', '/api/goods-receipts', { poNumber: p.poNumber, lines: inputs.map(([l, i]) => ({ sku: l.sku, qty: Number(i.value) })) });
          toast(`${t('receipt_saved', { grn: r.grn.grnNumber })}${r.resumed.length ? ` ${t('resumed_n', { n: r.resumed.length })}` : ''}`);
          render();
        } catch (x) { showErr(err, x); }
      };
      return f;
    };
    return h('li', { class: 'card po' },
      h('div', { class: 'card-head' }, h('div', {}, h('h2', { class: 'num', text: p.poNumber }), h('p', { class: 'muted small', text: `${names[p.vendorVat] || p.vendorVat} · ${t('ordered_by')}: ${p.buyer || '—'}` })),
        h('span', { class: `pct ${pct === 100 ? 'full' : ''}`, text: `${pct}% ${t('received_pct')}` })),
      h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: `width:${pct}%` })),
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, [t('item'), t('ordered'), t('col_received'), t('unit_price')].map((x, i) => h('th', { class: i ? 'num' : '', text: x })))),
        h('tbody', {}, p.lines.map((l) => h('tr', {}, h('td', { text: l.name }), h('td', { class: 'num', text: String(l.qty) }), h('td', { class: 'num', text: String(l.received) }), h('td', { class: 'num', text: money(l.unitPrice) })))))),
      canRecord && pct < 100 ? h('button', { class: 'btn', type: 'button', onclick: () => area.replaceChildren(form()), text: t('record') }) : null, area);
  };
  return h('div', { class: 'stack' }, h('div', { class: 'page-head' }, h('h1', { text: t('orders_title') }), h('p', { class: 'muted', text: t('orders_lead') })),
    pos.length ? h('ul', { class: 'po-list' }, pos.map(card)) : h('p', { class: 'card muted-card', text: t('no_orders') }));
}

// ---------------------------------------------------------------- suppliers
async function pageSuppliers() {
  const rows = await api('GET', '/api/suppliers');
  const canEdit = ['treasury', 'procurement', 'admin'].includes(state.me.user.role);
  const area = h('div', {});
  const form = (s = {}) => {
    const err = formError();
    const mk = (label, val, attrs = {}) => { const i = h('input', { type: 'text', value: val ?? '', ...attrs }); return [i, formField(label, i)]; };
    const [vat, fVat] = mk(t('vat_number'), s.vat, { maxlength: 15, inputmode: 'numeric', readonly: s.vat ? true : null });
    const [en, fEn] = mk(t('name_en'), s.nameEn, { maxlength: 120 });
    const [ar, fAr] = mk(t('name_ar'), s.nameAr, { maxlength: 120, dir: 'rtl' });
    const [ib, fIb] = mk(t('iban'), '', { maxlength: 34, placeholder: s.iban || 'SA…', autocomplete: 'off' });
    const [ph, fPh] = mk(t('phone'), s.phone, { type: 'tel', maxlength: 40 });
    const [em, fEm] = mk(t('supplier_email'), s.email, { type: 'email', maxlength: 254 });
    const [tm, fTm] = mk(t('terms'), s.paymentTermsDays ?? 30, { type: 'number', min: 0, max: 365 });
    const [dp, fDp] = mk(t('discount_pct'), s.earlyPayDiscount?.pct ?? 0, { type: 'number', min: 0, max: 20, step: '0.1' });
    const [dd, fDd] = mk(t('discount_days'), s.earlyPayDiscount?.days ?? 0, { type: 'number', min: 0, max: 365 });
    const f = h('form', { class: 'card form', novalidate: true }, h('h2', { text: s.vat ? `${t('edit')}: ${s.nameEn}` : t('add_supplier') }),
      h('div', { class: 'grid2' }, fVat, fEn, fAr, fIb, fPh, fEm, fTm, fDp, fDd), err,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit', text: t('save') }), h('button', { class: 'btn ghost', type: 'button', onclick: () => area.replaceChildren(), text: t('cancel') })));
    f.onsubmit = async (e) => {
      e.preventDefault();
      err.hidden = true;
      try {
        await api('POST', '/api/suppliers', { vat: vat.value.trim(), nameEn: en.value, nameAr: ar.value, iban: ib.value.trim(), phone: ph.value, email: em.value, paymentTermsDays: Number(tm.value), discountPct: Number(dp.value), discountDays: Number(dd.value) });
        toast(t('saved')); render();
      } catch (x) { showErr(err, x); }
    };
    return f;
  };
  return h('div', { class: 'stack' },
    h('div', { class: 'page-head row' }, h('div', {}, h('h1', { text: t('suppliers_title') }), h('p', { class: 'muted', text: t('suppliers_lead') })),
      canEdit ? h('button', { class: 'btn primary', type: 'button', onclick: () => { area.replaceChildren(form()); area.querySelector('input')?.focus(); }, text: t('add_supplier') }) : null),
    area,
    rows.length ? h('section', { class: 'card flush' }, h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, [t('col_supplier'), t('vat_number'), t('iban'), t('terms'), ''].map((x) => h('th', { text: x })))),
      h('tbody', {}, rows.map((s) => h('tr', {},
        h('td', {}, h('b', { text: pick(s.nameEn, s.nameAr) }), h('br'), h('span', { class: 'muted small', text: pick(s.nameAr, s.nameEn) })),
        h('td', { class: 'num', text: s.vat }), h('td', { class: 'num', text: s.iban }),
        h('td', { class: 'num', text: `${s.paymentTermsDays}${s.earlyPayDiscount ? ` · ${s.earlyPayDiscount.pct}%/${s.earlyPayDiscount.days}` : ''}` }),
        h('td', {}, canEdit ? h('button', { class: 'btn small', type: 'button', onclick: () => { area.replaceChildren(form(s)); window.scrollTo({ top: 0, behavior: 'smooth' }); }, text: t('edit') }) : null)))))))
      : h('p', { class: 'card muted-card', text: t('no_suppliers') }));
}

// ---------------------------------------------------------------- activity
async function pageActivity() {
  const a = await api('GET', '/api/audit');
  return h('div', { class: 'stack' }, h('div', { class: 'page-head' }, h('h1', { text: t('activity_title') }), h('p', { class: 'muted', text: t('activity_lead') })),
    h('p', { class: `integrity ${a.integrity.ok ? 'ok' : 'bad'}`, role: 'status', text: a.integrity.ok ? t('chain_ok', { n: a.integrity.entries }) : t('chain_bad', { n: a.integrity.brokenAt }) }),
    h('section', { class: 'card flush' }, h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, [t('when'), t('what'), t('on'), t('who')].map((x) => h('th', { text: x })))),
      h('tbody', {}, a.entries.map((e) => h('tr', {}, h('td', { class: 'num nowrap', text: when(e.ts) }), h('td', { text: ACTION_LABELS[state.lang][e.action] || e.action }),
        h('td', {}, e.target && /^WZN-/.test(e.target) ? h('a', { href: `#/invoice/${encodeURIComponent(e.target)}`, text: e.target }) : h('span', { class: 'num', text: e.target || '' })),
        h('td', { class: 'muted small', text: e.actorName || e.actor }))))))));
}

// ---------------------------------------------------------------- settings
async function pageSettings() {
  if (state.me.user.role !== 'admin') return h('p', { class: 'card muted-card', text: t('e_forbidden') });
  const sandbox = state.me.org.kind === 'sandbox';
  const users = await api('GET', '/api/users');

  const coErr = formError();
  const coName = h('input', { type: 'text', value: state.me.org.name, maxlength: 120 });
  const lim = h('input', { type: 'number', min: 0, step: 1000, value: state.me.org.approvalLimit });
  const coForm = h('form', { class: 'card form', novalidate: true }, h('h2', { text: t('company_settings') }), formField(t('company'), coName), formField(t('approval_limit'), lim, t('approval_limit_help')), coErr, h('button', { class: 'btn primary', type: 'submit', text: t('save') }));
  coForm.onsubmit = async (e) => { e.preventDefault(); coErr.hidden = true; try { await api('POST', '/api/settings', { name: coName.value, approvalLimit: Number(lim.value) }); await loadMe(); toast(t('saved')); render(); } catch (x) { showErr(coErr, x); } };

  const uErr = formError();
  const uName = h('input', { type: 'text', maxlength: 120 }), uEmail = h('input', { type: 'email', maxlength: 254 });
  const uRole = h('select', {}, ['ap', 'finance', 'procurement', 'warehouse', 'treasury', 'admin'].map((r) => h('option', { value: r, text: t(`role_${r}`) })));
  const secret = h('p', { class: 'secret', hidden: true, role: 'status' });
  const uForm = h('form', { class: 'action-form', novalidate: true }, h('div', { class: 'grid3' }, formField(t('full_name'), uName), formField(t('email'), uEmail), formField(t('role'), uRole)), uErr, h('button', { class: 'btn', type: 'submit', disabled: sandbox, text: t('add_person') }), secret);
  uForm.onsubmit = async (e) => {
    e.preventDefault(); uErr.hidden = true;
    try { const r = await api('POST', '/api/users', { name: uName.value, email: uEmail.value, role: uRole.value }); secret.textContent = `${t('temp_password', { email: r.user.email })} ${r.temporaryPassword}`; secret.hidden = false; uName.value = uEmail.value = ''; }
    catch (x) { showErr(uErr, x); }
  };
  const team = h('section', { class: 'card' }, h('h2', { text: t('team') }), sandbox ? h('p', { class: 'muted small', text: t('demo_settings_note') }) : null,
    h('ul', { class: 'people' }, users.map((u) => h('li', {}, h('div', {}, h('b', { text: u.name }), h('p', { class: 'muted small', text: `${u.email} · ${t(`role_${u.role}`)}` })),
      !sandbox && u.id !== state.me.user.id ? h('button', { class: 'btn small danger-ghost', type: 'button', onclick: async () => { try { await api('POST', `/api/users/${encodeURIComponent(u.id)}/remove`, {}); render(); } catch (x) { toast(errText(x), 'crit'); } }, text: t('remove') }) : null))),
    uForm);

  const imp = (kind, label, tpl) => {
    const err = formError();
    const res = h('p', { class: 'muted small', role: 'status' });
    const inp = h('input', { type: 'file', accept: '.csv,text/csv', 'aria-label': label });
    inp.onchange = () => {
      const f = inp.files[0];
      if (!f) return;
      if (f.size > 2 * 1024 * 1024) return showErr(err, t('file_too_big'));
      const fr = new FileReader();
      fr.onload = async () => {
        err.hidden = true;
        try { const r = await api('POST', `/api/import/${kind}`, { csv: String(fr.result) }); res.textContent = t('imported', { n: r.imported, e: r.errors.length }); }
        catch (x) { showErr(err, x); }
        inp.value = '';
      };
      fr.readAsText(f);
    };
    return h('div', { class: 'import-row' }, h('b', { text: label }), h('a', { href: `/templates/${tpl}`, download: tpl, text: t('template') }), inp, err, res);
  };
  const imports = h('section', { class: 'card' }, h('h2', { text: t('import_title') }), h('p', { class: 'muted', text: t('import_lead') }),
    imp('vendors', t('import_vendors'), 'suppliers.csv'), imp('purchase_orders', t('import_pos'), 'purchase-orders.csv'), imp('goods_receipts', t('import_grns'), 'goods-receipts.csv'),
    h('p', {}, h('a', { class: 'btn', href: '/api/export/ledger.csv', download: 'wazin-ledger.csv', text: t('export_ledger') })));

  const pErr = formError();
  const cur = h('input', { type: 'password', autocomplete: 'current-password' }), nxt = h('input', { type: 'password', autocomplete: 'new-password' });
  const pForm = h('form', { class: 'card form', novalidate: true }, h('h2', { text: t('change_password') }), formField(t('current_password'), cur), formField(t('new_password'), nxt, t('password_rule')), pErr, h('button', { class: 'btn', type: 'submit', disabled: sandbox, text: t('save') }));
  pForm.onsubmit = async (e) => { e.preventDefault(); pErr.hidden = true; try { await api('POST', '/api/me/password', { current: cur.value, next: nxt.value }); cur.value = nxt.value = ''; toast(t('saved')); } catch (x) { showErr(pErr, x); } };

  return h('div', { class: 'stack' }, h('div', { class: 'page-head' }, h('h1', { text: t('settings_title') })), coForm, team, imports, pForm);
}

// ---------------------------------------------------------------- boot
(async function boot() {
  applyLang();
  try { state.config = await api('GET', '/api/config'); } catch { /* defaults */ }
  render();
})();
