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
  me: null, csrf: '', config: { signup: true, ai: false },
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

// Company set-up: which teams exist. A task for a team the company does not have goes to the administrator.
const TEAM_OF_OWNER = { FINANCE_MANAGER: 'finance', PROCUREMENT: 'procurement', WAREHOUSE: 'warehouse', TREASURY: 'treasury' };
const teamOn = (team) => state.me?.org?.settings?.teams?.[team] !== false;
const ownerLabel = (owner) => (TEAM_OF_OWNER[owner] && !teamOn(TEAM_OF_OWNER[owner]) ? t('role_admin') : t(`ow_${owner}`));
const availableRoles = () => ['ap', 'finance', 'procurement', 'warehouse', 'treasury', 'admin'].filter((r) => !['finance', 'procurement', 'warehouse', 'treasury'].includes(r) || teamOn(r));

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
    if (!state.me && page === 'help') { app.replaceChildren(publicFrame(helpContent())); focusMain(); return; }
    if (!state.me) return go('#/welcome');
  }
  if (publicPages[page]) {
    if (state.me) return go('#/home');
    app.replaceChildren(publicPages[page]());
    focusMain();
    return;
  }
  const pages = { home: pageHome, invoices: pageInvoices, invoice: pageInvoice, new: pageNew, orders: pageOrders, suppliers: pageSuppliers, activity: pageActivity, settings: pageSettings, profile: pageProfile, help: async () => helpContent() };
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
  ['profile', 'nav_profile', 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1'],
  ['help', 'nav_help', 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01'],
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
// ---------------------------------------------------------------- display preferences (text size, contrast)
const prefs = { size: Number(store.get('wz_size') || 0), contrast: store.get('wz_contrast') === '1' };
function applyPrefs() {
  document.documentElement.dataset.size = String(prefs.size);
  document.documentElement.dataset.contrast = prefs.contrast ? 'high' : 'normal';
}
function setSize(d) { prefs.size = Math.max(-1, Math.min(2, prefs.size + d)); store.set('wz_size', String(prefs.size)); applyPrefs(); }
function toggleContrast() { prefs.contrast = !prefs.contrast; store.set('wz_contrast', prefs.contrast ? '1' : '0'); applyPrefs(); render(); }

function todayLine() {
  const d = new Date();
  try {
    const hijri = new Intl.DateTimeFormat(isAr() ? 'ar-SA-u-ca-islamic-umalqura-nu-latn' : 'en-GB-u-ca-islamic-umalqura', { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
    const greg = new Intl.DateTimeFormat(isAr() ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
    return `${hijri} · ${greg}`;
  } catch { return d.toDateString(); }
}

// Thin bar above every page: date (Hijri and Gregorian), text size, contrast, language.
function utilityBar() {
  return h('div', { class: 'util' }, h('div', { class: 'wrap util-in' },
    h('span', { class: 'util-date', text: todayLine() }),
    h('div', { class: 'spacer' }),
    h('div', { class: 'util-tools', role: 'group', 'aria-label': t('a11y_tools') },
      h('button', { type: 'button', class: 'util-btn', onclick: () => setSize(-1), 'aria-label': t('text_smaller'), text: 'A−' }),
      h('button', { type: 'button', class: 'util-btn', onclick: () => setSize(1), 'aria-label': t('text_bigger'), text: 'A+' }),
      h('button', { type: 'button', class: 'util-btn', onclick: toggleContrast, 'aria-pressed': String(prefs.contrast), text: t('contrast') })),
    langButton()));
}

function shell(current, main) {
  const { user, org } = state.me;
  const signOut = h('button', { class: 'btn ghost small', type: 'button', onclick: async () => { try { await api('POST', '/api/logout', {}); } catch { /* already gone */ } state.me = null; state.csrf = ''; go('#/welcome'); }, text: t('sign_out') });
  const who = h('a', { class: 'who', href: '#/profile', title: t('nav_profile') }, h('span', { class: 'avatar', 'aria-hidden': 'true', text: (user.name || '?').trim().charAt(0) }), h('span', { class: 'who-txt' }, h('b', { text: user.name }), h('span', { text: t(`role_${user.role}`) })));

  const top = h('header', { class: 'topbar' },
    h('div', { class: 'topbar-in wrap' },
      brand(),
      h('span', { class: 'org' }, h('span', { class: 'org-label', text: t('company') }), h('b', { text: org.name })),
      h('div', { class: 'spacer' }),
      h('span', { class: 'hide-sm' }, who),
      h('span', { class: 'hide-sm' }, signOut)));

  const items = navItems();
  const side = h('nav', { class: 'sidenav', 'aria-label': 'Main' }, items.map(([k, label, d]) =>
    h('a', { href: `#/${k}`, class: current === k || (k === 'invoices' && current === 'invoice') ? 'active' : '', 'aria-current': current === k ? 'page' : null }, icon(d), h('span', { text: t(label) }))));

  // Mobile: four main tabs plus "More".
  const moreSheet = h('div', { class: 'sheet', hidden: true, id: 'more' },
    h('div', { class: 'sheet-card' },
      h('div', { class: 'sheet-who' }, who.cloneNode(true)),
      items.slice(4).map(([k, label, d]) => h('a', { href: `#/${k}`, onclick: () => (moreSheet.hidden = true) }, icon(d), h('span', { text: t(label) }))),
      h('button', { class: 'sheet-signout', type: 'button', onclick: () => signOut.click(), text: t('sign_out') })));
  moreSheet.addEventListener('click', (e) => { if (e.target === moreSheet) moreSheet.hidden = true; });
  const bottom = h('nav', { class: 'bottomnav', 'aria-label': 'Main' },
    items.slice(0, 4).map(([k, label, d]) => h('a', { href: `#/${k}`, class: current === k || (k === 'invoices' && current === 'invoice') ? 'active' : '' }, icon(d), h('span', { text: t(label) }))),
    h('button', { type: 'button', class: ['suppliers', 'activity', 'settings', 'profile', 'help'].includes(current) ? 'active' : '', onclick: () => (moreSheet.hidden = !moreSheet.hidden), 'aria-expanded': 'false' }, icon('M4 6h16M4 12h16M4 18h16'), h('span', { text: t('nav_more') })));

  const crumbs = h('nav', { class: 'crumbs wrap', 'aria-label': t('breadcrumb') },
    h('a', { href: '#/home', text: t('nav_home') }),
    current !== 'home' ? h('span', { 'aria-hidden': 'true', text: isAr() ? '‹' : '›' }) : null,
    current !== 'home' ? h('span', { 'aria-current': 'page', text: t(current === 'invoice' ? 'nav_invoices' : `nav_${current}`) }) : null);

  return h('div', { class: 'layout' }, utilityBar(), top, crumbs, h('div', { class: 'body wrap' }, side, main), bottom, moreSheet, siteFooter(false));
}

// ---------------------------------------------------------------- public site
const scrollTo = (id) => (e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

function siteFooter(full) {
  const bottom = h('div', { class: 'foot-bottom wrap' },
    h('span', { text: t('foot_rights') }),
    h('span', { text: t('foot_independent') }));
  if (!full) return h('footer', { class: 'site-foot slim' }, bottom);
  const col = (title, ...items) => h('div', { class: 'foot-col' }, h('h2', { text: title }), h('ul', {}, items.map((x) => h('li', {}, x))));
  return h('footer', { class: 'site-foot' },
    h('div', { class: 'foot-cols wrap' },
      h('div', { class: 'foot-col foot-brand' }, h('span', { class: 'brand on-dark' }, mark(), h('span', { class: 'brand-name' }, h('b', { text: 'Wazin' }), h('span', { class: 'brand-ar', lang: 'ar', text: 'وازِن' }))), h('p', { text: t('foot_about') })),
      col(t('foot_service'),
        h('a', { href: '#how', onclick: scrollTo('how'), text: t('pub_nav_how') }),
        h('a', { href: '#why', onclick: scrollTo('why'), text: t('pub_nav_why') }),
        h('a', { href: '#teams', onclick: scrollTo('teams'), text: t('pub_nav_teams') }),
        h('a', { href: '#trust', onclick: scrollTo('trust'), text: t('pub_nav_trust') })),
      col(t('foot_account'),
        h('a', { href: '#/signin', text: t('sign_in') }),
        h('a', { href: '#/help', text: t('nav_help') }),
        state.config.signup ? h('a', { href: '#/signup', text: t('create_workspace') }) : null),
      col(t('foot_compliance'), t('foot_c1'), t('foot_c2'), t('foot_c3'))),
    bottom);
}

function publicFrame(...content) {
  const nav = h('nav', { class: 'pub-nav hide-sm', 'aria-label': 'Main' },
    h('a', { href: '#how', onclick: (e) => { if (route().page !== 'welcome') return; scrollTo('how')(e); }, text: t('pub_nav_how') }),
    h('a', { href: '#why', onclick: (e) => { if (route().page !== 'welcome') return; scrollTo('why')(e); }, text: t('pub_nav_why') }),
    h('a', { href: '#teams', onclick: (e) => { if (route().page !== 'welcome') return; scrollTo('teams')(e); }, text: t('pub_nav_teams') }),
    h('a', { href: '#trust', onclick: (e) => { if (route().page !== 'welcome') return; scrollTo('trust')(e); }, text: t('pub_nav_trust') }),
    h('a', { href: '#/help', 'data-keep': '1', text: t('nav_help') }));
  nav.querySelectorAll('a:not([data-keep])').forEach((a) => { if (route().page !== 'welcome') a.setAttribute('href', '#/welcome'); });
  return h('div', { class: 'public' },
    utilityBar(),
    h('header', { class: 'pub-top' }, h('div', { class: 'wrap pub-top-in' },
      h('a', { href: '#/welcome', class: 'brand' }, mark(), h('span', { class: 'brand-name' }, h('b', { text: 'Wazin' }), h('span', { class: 'brand-ar', lang: 'ar', text: 'وازِن' }))),
      nav, h('div', { class: 'spacer' }),
      h('a', { class: 'btn small', href: '#/signin', text: t('sign_in') }),
      state.config.signup ? h('a', { class: 'btn primary small hide-xs', href: '#/signup', text: t('open_account') }) : null)),
    h('main', { id: 'main', tabindex: '-1', class: 'pub-main' }, ...content),
    siteFooter(true));
}

function pageWelcome() {
  const img = (src, alt = '') => h('img', { src, alt, width: 64, height: 64, loading: 'lazy', decoding: 'async' });

  // Hero, with a preview of how one invoice is checked.
  const check = (ok, label) => h('li', { class: ok ? 'ok' : 'stop' }, h('span', { class: 'pv-dot', 'aria-hidden': 'true', text: ok ? '✓' : '!' }), h('span', { text: label }));
  const preview = h('figure', { class: 'preview', 'aria-label': t('pv_label') },
    h('div', { class: 'pv-head' }, h('b', { text: t('pv_supplier') }), h('span', { class: 'num', text: 'SAR 12,995.00' })),
    h('p', { class: 'pv-sub', text: t('pv_sub') }),
    h('ul', { class: 'pv-checks' }, check(true, t('pv_c1')), check(true, t('pv_c2')), check(true, t('pv_c3')), check(true, t('pv_c4')), check(false, t('pv_c5'))),
    h('div', { class: 'pv-verdict' }, h('span', { class: 'pill tone-crit', text: t('st_BLOCKED') }), h('span', { text: t('pv_to') })));
  const hero = h('section', { class: 'hero-band' }, h('div', { class: 'wrap hero-grid' },
    h('div', { class: 'hero' },
      h('p', { class: 'eyebrow', text: t('hero_eyebrow') }),
      h('h1', { text: t('hero_title') }),
      h('p', { class: 'lead', text: t('hero_lead') }),
      h('div', { class: 'cta' },
        state.config.signup ? h('a', { class: 'btn primary big', href: '#/signup', text: t('open_account') }) : null,
        h('a', { class: 'btn big', href: '#/signin', text: t('sign_in') })),
      h('ul', { class: 'trust-row' }, ['trust_1', 'trust_2', 'trust_3'].map((k) => h('li', { text: t(k) })))),
    preview));

  // Why it is needed: local evidence, each with its source.
  const why = h('section', { class: 'band', id: 'why', 'aria-labelledby': 'why_h' }, h('div', { class: 'wrap' },
    h('p', { class: 'eyebrow', text: t('why_eyebrow') }),
    h('h2', { id: 'why_h', class: 'band-title', text: t('why_title') }),
    h('p', { class: 'band-lead', text: t('why_lead') }),
    h('div', { class: 'evidence' }, [1, 2, 3, 4, 5].map((n) => h('article', { class: 'ev' },
      h('p', { class: 'ev-fig', text: t(`ev${n}_fig`) }),
      h('h3', { text: t(`ev${n}_t`) }),
      h('p', { text: t(`ev${n}_d`) }),
      h('p', { class: 'ev-src', text: t(`ev${n}_src`) }))))));

  // How it works: five steps.
  const icons = ['1-read', '2-check', '3-weigh', '4-act', '5-follow-up'];
  const how = h('section', { class: 'band alt', id: 'how', 'aria-labelledby': 'how_h' }, h('div', { class: 'wrap' },
    h('p', { class: 'eyebrow', text: t('how_eyebrow') }),
    h('h2', { id: 'how_h', class: 'band-title', text: t('how_title') }),
    h('ol', { class: 'steps5' }, icons.map((ic, i) => h('li', {},
      img(`/img/${ic}.svg`),
      h('span', { class: 'step-n', text: String(i + 1) }),
      h('h3', { text: t(`s${i + 1}_t`) }),
      h('p', { text: t(`s${i + 1}_d`) }))))));

  // Who it is for: the six teams.
  const teamIcon = { ap: 'M6 2h9l5 5v15H6zM14 2v6h6M9 13h8M9 17h8', finance: 'M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6', procurement: 'M3 3h2l2.5 12h11L21 7H6.5M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM18 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', warehouse: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10', treasury: 'M3 10h18M5 10v8M9 10v8M15 10v8M19 10v8M3 21h18M12 3l9 5H3z', admin: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1' };
  const teams = h('section', { class: 'band', id: 'teams', 'aria-labelledby': 'teams_h' }, h('div', { class: 'wrap' },
    h('p', { class: 'eyebrow', text: t('teams_eyebrow') }),
    h('h2', { id: 'teams_h', class: 'band-title', text: t('teams_title') }),
    h('p', { class: 'band-lead', text: t('teams_lead') }),
    h('div', { class: 'team-grid' }, ['ap', 'finance', 'procurement', 'warehouse', 'treasury', 'admin'].map((r) => h('article', { class: 'team-card' },
      h('span', { class: 'team-ico' }, icon(teamIcon[r])),
      h('h3', { text: t(`role_${r}`) }),
      h('p', { text: t(`team_${r}`) }))))));

  // Any size of company, and the suppliers on the other side.
  const sizes = h('section', { class: 'band alt', id: 'sizes', 'aria-labelledby': 'sizes_h' }, h('div', { class: 'wrap' },
    h('p', { class: 'eyebrow', text: t('sizes_eyebrow') }),
    h('h2', { id: 'sizes_h', class: 'band-title', text: t('sizes_title') }),
    h('div', { class: 'size-grid' }, ['small', 'mid', 'large', 'supplier'].map((k) => h('article', { class: `size-card${k === 'supplier' ? ' supplier' : ''}` },
      h('p', { class: 'size-tag', text: t(`size_${k}_tag`) }),
      h('h3', { text: t(`size_${k}_t`) }),
      h('p', { text: t(`size_${k}_d`) }))))));

  // Trust and compliance.
  const trust = h('section', { class: 'band alt', id: 'trust', 'aria-labelledby': 'trust_h' }, h('div', { class: 'wrap trust-grid' },
    h('div', {}, h('p', { class: 'eyebrow', text: t('trust_eyebrow') }), h('h2', { id: 'trust_h', class: 'band-title', text: t('trust_title') }), h('p', { class: 'band-lead', text: t('trust_lead') })),
    h('ul', { class: 'trust-list' }, [1, 2, 3, 4, 6, 7, 5].map((n) => h('li', {}, h('b', { text: t(`tr${n}_t`) }), h('span', { text: t(`tr${n}_d`) }))))));

  const closing = h('section', { class: 'cta-band' }, h('div', { class: 'wrap cta-band-in' },
    h('div', {}, h('h2', { text: t('cta_title') }), h('p', { text: t('cta_lead') })),
    h('div', { class: 'cta' },
      state.config.signup ? h('a', { class: 'btn primary big', href: '#/signup', text: t('open_account') }) : null,
      h('a', { class: 'btn big on-dark', href: '#/signin', text: t('sign_in') }))));

  return publicFrame(hero, why, how, teams, sizes, trust, closing);
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
      h('ul', { class: 'owners' }, ownersOrder.filter((o) => !TEAM_OF_OWNER[o] || teamOn(TEAM_OF_OWNER[o])).map((o) => h('li', {}, h('span', { text: t(`ow_${o}`) }), h('b', { class: d.byOwner[o] ? 'has' : '', text: String(d.byOwner[o] || 0) }))))));
}

function invoiceList(rows) {
  return h('ul', { class: 'inv-list' }, rows.map((r) => h('li', {},
    h('a', { href: `#/invoice/${encodeURIComponent(r.id)}`, class: `inv-row tone-${STATUS_TONE[r.status]}` },
      h('span', { class: 'inv-main' }, h('b', { text: r.vendorName || t('unreadable') }), h('span', { class: 'muted small', text: `${r.invoiceNumber || r.id} · ${r.poNumber || '—'}` })),
      h('span', { class: 'inv-amt num', text: money(r.total) }),
      h('span', { class: 'inv-state' }, pill(r.status), r.owner !== 'NONE' ? h('span', { class: 'muted small', text: ownerLabel(r.owner) }) : null)))));
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
    h('div', {}, pill(v.status), v.owner !== 'NONE' ? h('span', { class: 'owner', text: `→ ${ownerLabel(v.owner)}` }) : null),
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
    return h('section', { class: 'card muted-card' }, h('p', { text: t('not_your_action', { owner: ownerLabel(v.owner) }) }));
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
  return h('div', { class: 'stack' },
    h('div', { class: 'page-head' }, h('h1', { text: t('new_title') }), h('p', { class: 'muted', text: t('new_lead') })),
    canUpload ? form : h('p', { class: 'card muted-card', text: t('e_forbidden') }));
}

// ---------------------------------------------------------------- orders
async function pageOrders() {
  const [pos, sup] = await Promise.all([api('GET', '/api/purchase-orders'), api('GET', '/api/suppliers')]);
  const names = Object.fromEntries(sup.map((s) => [s.vat, pick(s.nameEn, s.nameAr)]));
  const canRecord = ['warehouse', 'admin'].includes(state.me.user.role) && state.me.org.settings?.matching !== 'two';
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
  const users = await api('GET', '/api/users');

  const coErr = formError();
  const coName = h('input', { type: 'text', value: state.me.org.name, maxlength: 120 });
  const lim = h('input', { type: 'number', min: 0, step: 1000, value: state.me.org.approvalLimit });
  const coForm = h('form', { class: 'card form', novalidate: true }, h('h2', { text: t('company_settings') }), formField(t('company'), coName), formField(t('approval_limit'), lim, t('approval_limit_help')), coErr, h('button', { class: 'btn primary', type: 'submit', text: t('save') }));
  coForm.onsubmit = async (e) => { e.preventDefault(); coErr.hidden = true; try { await api('POST', '/api/settings', { name: coName.value, approvalLimit: Number(lim.value) }); await loadMe(); toast(t('saved')); render(); } catch (x) { showErr(coErr, x); } };

  // How your company works: a few choices with sensible defaults.
  const ws = state.me.org.settings || {};
  const wErr = formError();
  const radio = (name, value, checked, label, help) => h('label', { class: 'choice' }, h('input', { type: 'radio', name, value, checked }), h('span', {}, h('b', { text: label }), help ? h('span', { class: 'muted small', text: help }) : null));
  const teamKeys = ['finance', 'procurement', 'warehouse', 'treasury'];
  const anyTeam = teamKeys.some((k) => ws.teams?.[k]);
  const teamBoxes = h('div', { class: 'team-boxes' }, teamKeys.map((k) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'team', value: k, checked: !!ws.teams?.[k] }), h('span', {}, h('b', { text: t(`role_${k}`) }), h('span', { class: 'muted small', text: t(`team_${k}`) })))));
  teamBoxes.hidden = !anyTeam;
  const who = h('fieldset', {}, h('legend', { text: t('ws_who') }),
    radio('who', 'solo', !anyTeam, t('ws_solo'), t('ws_solo_help')),
    radio('who', 'team', anyTeam, t('ws_team'), t('ws_team_help')), teamBoxes);
  who.addEventListener('change', (e) => {
    if (e.target.name !== 'who') return;
    teamBoxes.hidden = e.target.value !== 'team';
    const boxes = [...teamBoxes.querySelectorAll('input')];
    if (e.target.value === 'team' && !boxes.some((x) => x.checked)) boxes.forEach((x) => (x.checked = true));
  });
  const how = h('fieldset', {}, h('legend', { text: t('ws_match') }),
    radio('match', 'three', ws.matching !== 'two', t('ws_three'), t('ws_three_help')),
    radio('match', 'two', ws.matching === 'two', t('ws_two'), t('ws_two_help')));
  const tol = h('input', { type: 'number', min: 0, max: 10, step: 0.5, value: ws.priceTolerancePct ?? 1 });
  const early = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: ws.earlyPay !== false }), h('span', {}, h('b', { text: t('ws_early') }), h('span', { class: 'muted small', text: t('ws_early_help') })));
  const wForm = h('form', { class: 'card form', novalidate: true }, h('h2', { text: t('ws_title') }), h('p', { class: 'muted', text: t('ws_lead') }), who, how,
    formField(t('ws_tol'), tol, t('ws_tol_help')), early, wErr, h('button', { class: 'btn primary', type: 'submit', text: t('save') }));
  wForm.onsubmit = async (e) => {
    e.preventDefault(); wErr.hidden = true;
    const solo = wForm.querySelector('input[name=who]:checked').value === 'solo';
    const teams = Object.fromEntries(teamKeys.map((k) => [k, !solo && wForm.querySelector(`input[name=team][value=${k}]`).checked]));
    const matching = wForm.querySelector('input[name=match]:checked').value;
    try { await api('POST', '/api/settings', { settings: { teams, matching, priceTolerancePct: Number(tol.value), earlyPay: early.querySelector('input').checked } }); await loadMe(); toast(t('saved')); render(); }
    catch (x) { showErr(wErr, x); }
  };

  const uErr = formError();
  const uName = h('input', { type: 'text', maxlength: 120 }), uEmail = h('input', { type: 'email', maxlength: 254 });
  const uRole = h('select', {}, availableRoles().map((r) => h('option', { value: r, text: t(`role_${r}`) })));
  const secret = h('p', { class: 'secret', hidden: true, role: 'status' });
  const uForm = h('form', { class: 'action-form', novalidate: true }, h('div', { class: 'grid3' }, formField(t('full_name'), uName), formField(t('email'), uEmail), formField(t('role'), uRole)), uErr, h('button', { class: 'btn', type: 'submit', text: t('add_person') }), secret);
  uForm.onsubmit = async (e) => {
    e.preventDefault(); uErr.hidden = true;
    try { const r = await api('POST', '/api/users', { name: uName.value, email: uEmail.value, role: uRole.value }); secret.textContent = `${t('temp_password', { email: r.user.email })} ${r.temporaryPassword}`; secret.hidden = false; uName.value = uEmail.value = ''; }
    catch (x) { showErr(uErr, x); }
  };
  const team = h('section', { class: 'card' }, h('h2', { text: t('team') }),
    h('ul', { class: 'people' }, users.map((u) => h('li', {}, h('div', {}, h('b', { text: u.name }), h('p', { class: 'muted small', text: `${u.email} · ${t(`role_${u.role}`)}` })),
      u.id !== state.me.user.id ? h('button', { class: 'btn small danger-ghost', type: 'button', onclick: async () => { try { await api('POST', `/api/users/${encodeURIComponent(u.id)}/remove`, {}); render(); } catch (x) { toast(errText(x), 'crit'); } }, text: t('remove') }) : null))),
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

  return h('div', { class: 'stack' }, h('div', { class: 'page-head' }, h('h1', { text: t('settings_title') })), wForm, coForm, team, imports);
}

// ---------------------------------------------------------------- profile
async function pageProfile() {
  const { user, org } = state.me;
  const a = await api('GET', '/api/me/activity');
  const label = (k) => ACTION_LABELS[state.lang][k] || k;
  // One row: label (and optional hint) on one side, value or control on the other.
  const row = (title, hint, ...right) => h('div', { class: 'p-row' },
    h('div', { class: 'p-row-l' }, h('b', { text: title }), hint ? h('span', { class: 'muted small', text: hint }) : null),
    h('div', { class: 'p-row-r' }, ...right));

  // Header
  const hero = h('section', { class: 'card p-hero' },
    h('span', { class: 'avatar big', 'aria-hidden': 'true', text: (user.name || '?').trim().charAt(0) }),
    h('div', { class: 'p-hero-txt' }, h('h1', { text: user.name }), h('p', { class: 'muted', text: `${t(`role_${user.role}`)} · ${org.name}` })),
    h('a', { class: `btn ${a.openTasks ? 'primary' : ''}`, href: '#/home' }, t('prof_tasks'), h('span', { class: 'p-count', text: String(a.openTasks) })));

  // Summary strip
  const stat = (k, v, tone = '') => h('div', { class: `p-stat ${tone}` }, h('span', { class: 'p-stat-v', text: v }), h('span', { class: 'p-stat-k', text: k }));
  const strip = h('section', { class: 'card p-strip', 'aria-label': t('prof_work') },
    stat(t('prof_actions'), String(a.actions30d)),
    stat(t('prof_last'), a.previousSignIn ? when(a.previousSignIn) : '—'),
    stat(t('prof_failed'), String(a.failedSincePrevious), a.failedSincePrevious ? 'bad' : ''));
  const warn = a.failedSincePrevious ? h('p', { class: 'form-error', role: 'alert', text: t('prof_failed_warn') }) : null;

  // Recent activity
  const recent = h('section', { class: 'card' }, h('h2', { text: t('prof_recent') }),
    a.recent.length ? h('ul', { class: 'p-list' }, a.recent.slice(0, 6).map((e) => h('li', {},
      h('span', { class: 'p-dot', 'aria-hidden': 'true' }),
      e.target && /^WZN-/.test(e.target) ? h('a', { href: `#/invoice/${encodeURIComponent(e.target)}` }, `${label(e.action)} · ${e.target}`) : h('span', { text: label(e.action) }),
      h('span', { class: 'muted small p-time', text: when(e.ts) }))))
      : h('p', { class: 'muted', text: t('prof_recent_none') }),
    a.recent.length > 6 ? h('a', { href: '#/activity', class: 'small', text: t('prof_all_activity') }) : null);

  // Account
  const nErr = formError();
  const nm = h('input', { type: 'text', value: user.name, maxlength: 120, autocomplete: 'name', 'aria-label': t('full_name') });
  const nameForm = h('form', { class: 'p-inline', novalidate: true }, nm, h('button', { class: 'btn', type: 'submit', text: t('save') }));
  nameForm.onsubmit = async (e) => { e.preventDefault(); nErr.hidden = true; try { const r = await api('POST', '/api/me/profile', { name: nm.value }); state.me = { ...state.me, ...r }; toast(t('saved')); render(); } catch (x) { showErr(nErr, x); } };
  const account = h('section', { class: 'card' }, h('h2', { text: t('prof_account') }),
    row(t('full_name'), null, nameForm), nErr,
    row(t('email'), null, h('span', { class: 'p-val', text: user.email })),
    row(t('role'), null, h('span', { class: 'p-val', text: t(`role_${user.role}`) })),
    row(t('company'), null, h('span', { class: 'p-val', text: org.name })),
    h('p', { class: 'muted small', text: t('prof_managed') }));

  // Security
  const pErr = formError();
  const cur = h('input', { type: 'password', autocomplete: 'current-password' }), nxt = h('input', { type: 'password', autocomplete: 'new-password' });
  const pForm = h('form', { class: 'p-pw', novalidate: true, hidden: true }, formField(t('current_password'), cur), formField(t('new_password'), nxt, t('password_rule')), pErr,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit', text: t('save') }), h('button', { class: 'btn ghost', type: 'button', onclick: () => { pForm.hidden = true; }, text: t('cancel') })));
  pForm.onsubmit = async (e) => { e.preventDefault(); pErr.hidden = true; try { await api('POST', '/api/me/password', { current: cur.value, next: nxt.value }); toast(t('saved')); state.me = null; state.csrf = ''; go('#/signin'); } catch (x) { showErr(pErr, x); } };
  const others = h('button', { class: 'btn', type: 'button', disabled: a.devices < 2, text: t('prof_signout_others') });
  others.onclick = async () => { try { const r = await api('POST', '/api/me/sign-out-others', {}); toast(t('prof_signed_out', { n: r.signedOut })); render(); } catch (x) { toast(errText(x), 'crit'); } };
  const security = h('section', { class: 'card' }, h('h2', { text: t('prof_security') }),
    row(t('change_password'), t('password_rule'), h('button', { class: 'btn', type: 'button', onclick: () => { pForm.hidden = false; cur.focus(); }, text: t('prof_change') })), pForm,
    row(t('prof_devices_t'), t('prof_devices', { n: a.devices }), others));

  // Preferences
  const prefs = h('section', { class: 'card' }, h('h2', { text: t('prof_prefs') }),
    row(t('prof_lang'), t('prof_prefs_help'), langButton()));

  return h('div', { class: 'stack p-page' }, hero, strip, warn, recent, account, security, prefs);
}

// ---------------------------------------------------------------- help and contact
function helpContent() {
  const faq = [1, 2, 3, 4, 5, 6, 7].map((n) => h('details', { class: 'faq' }, h('summary', { text: t(`faq${n}_q`) }), h('p', { text: t(`faq${n}_a`) })));
  const mail = state.config.support;
  const contact = h('section', { class: 'card contact' }, h('h2', { text: t('help_contact') }),
    mail ? h('p', {}, t('help_contact_lead'), ' ', h('a', { href: `mailto:${mail}?subject=${encodeURIComponent('Wazin')}`, text: mail }))
      : h('p', { class: 'muted', text: t('help_contact_none') }),
    h('p', { class: 'muted small', text: t('help_contact_time') }));
  return h('div', { class: state.me ? 'stack' : 'stack wrap help-public' },
    h('div', { class: 'page-head' }, h('h1', { text: t('nav_help') }), h('p', { class: 'muted', text: t('help_lead') })),
    h('section', { class: 'card' }, h('h2', { text: t('help_faq') }), faq), contact);
}

// ---------------------------------------------------------------- boot
(async function boot() {
  applyPrefs();
  applyLang();
  try { state.config = await api('GET', '/api/config'); } catch { /* defaults */ }
  render();
})();
