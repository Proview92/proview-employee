/* =====================================================================
   Proview Employee — master admin (Proview) and licence checks
   Same licence rules as Proview Signage, with one licence per staff member:
   3-day trial; 1, 3, 6, 12, 24 or 36 months; lifetime; custom end date;
   renewals can be added on top; 7 days' grace after the end (none for
   trials), then that person is locked out. The database enforces all of
   this (supabase/schema.sql); this file is the screens.
   ===================================================================== */
(function () {
  'use strict';
  const O = window.PE_ONLINE;
  if (!O) return;

  /* ---------------- licence helpers (keep GRACE in step with the database) ---------------- */
  const LIC_GRACE_DAYS = 7, DAY = 864e5;
  const LIC_TYPES = [['trial3', '3-day trial'], ['m1', '1 month'], ['m3', '3 months'], ['m6', '6 months'], ['m12', '12 months'],
    ['m24', '24 months'], ['m36', '36 months'], ['lifetime', 'Lifetime'], ['custom', 'Custom end date']];
  const MONTHS = { m1: 1, m3: 3, m6: 6, m12: 12, m24: 24, m36: 36 };
  const licLabel = (t) => (LIC_TYPES.find(([k]) => k === t) || [null, 'No licence'])[1];
  const fmt = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : /(s|sh|ch|x)$/.test(w) ? 'es' : 's'}`;
  function licState(l, now = Date.now()) {
    const type = l?.type ?? l?.license_type;
    const expires = l?.expires ?? l?.expires_at;
    if (!type) return { state: 'none', type };
    if (type === 'lifetime' || !expires) return { state: 'lifetime', type };
    const exp = new Date(expires).getTime(), daysLeft = Math.ceil((exp - now) / DAY);
    if (now < exp) return { state: daysLeft <= 14 ? 'expiring' : 'active', type, daysLeft, expires: exp };
    const graceEnd = exp + (type === 'trial3' ? 0 : LIC_GRACE_DAYS) * DAY;
    if (now < graceEnd) return { state: 'grace', type, daysLeft, graceLeft: Math.ceil((graceEnd - now) / DAY), expires: exp };
    return { state: 'expired', type, daysLeft, expires: exp };
  }
  function licSummary(l) {
    const L = licState(l), trial = L.type === 'trial3';
    switch (L.state) {
      case 'none': return { text: 'No licence', tone: 'red', L };
      case 'lifetime': return { text: 'Lifetime', tone: 'green', L };
      case 'active': return { text: `${trial ? 'Trial' : 'Licensed'} · until ${fmt(L.expires)}`, tone: trial ? 'amber' : 'green', L };
      case 'expiring': return { text: `${trial ? 'Trial' : 'Licence'} ends in ${plural(L.daysLeft, 'day')}`, tone: 'amber', L };
      case 'grace': return { text: `Ended · ${plural(L.graceLeft, 'day')} grace left`, tone: 'red', L };
      default: return { text: trial ? 'Trial ended' : 'Licence ended', tone: 'red', L };
    }
  }
  const licBadge = (l) => { const s = licSummary(l); return `<span class="chip ${s.tone}">${esc(s.text)}</span>`; };
  const licOk = (l) => ['active', 'expiring', 'lifetime', 'grace'].includes(licState(l).state);
  function previewEnd(type, { extend, current, custom }) {
    if (type === 'lifetime') return null;
    if (type === 'custom') return custom ? new Date(custom + 'T23:59:00') : undefined;
    const now = new Date();
    const base = extend && current && new Date(current) > now ? new Date(current) : now;
    const d = new Date(base);
    if (type === 'trial3') d.setDate(d.getDate() + 3);
    else { const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + MONTHS[type]); d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); }
    return d;
  }
  window.PE_LIC = { licState, licSummary, licBadge, licOk, LIC_TYPES };

  let pickList = null, pickLoading = false;
  /* ---------------- master admin (Proview) ----------------
     Businesses and licences are managed only at license.proviewcrm.co.uk.
     In the app a master admin simply opens a business (the last one used, or the
     first) and switches with the picker under the logo. */
  const LIC_PORTAL = 'https://license.proviewcrm.co.uk';
  async function open() {
    const last = O.lsGet('pe-last-org:' + O.user.id);
    let list = [];
    try { const { data, error } = await O.sb.rpc('pe_master_overview'); if (error) throw error; list = data || []; } catch (e) { toast(O.friendly(e), 'bad'); }
    pickList = list.map((o) => ({ id: o.id, name: o.name }));
    const mine = (O.orgs || []).filter((o) => !o.locked);
    const own = mine.find((o) => o.org_id === last);
    if (own) return O.enterOrg(own);
    const o = list.find((x) => x.id === last) || null;
    if (o) return O.enterOrg({ org_id: o.id, org_name: o.name, member_id: 'proview-master', role: 'Owner', as_master: true });
    if (mine.length) return O.enterOrg(mine[0]);
    if (list.length) return O.enterOrg({ org_id: list[0].id, org_name: list[0].name, member_id: 'proview-master', role: 'Owner', as_master: true });
    openModal(`<div class="pad"><b style="font-size:17px">No businesses yet</b><p class="small mut">Add businesses and licences in the Proview licence portal, then come back here.</p><div class="row" style="gap:8px;justify-content:flex-end"><button class="btn" data-act="signOut">Sign out</button><a class="btn pri" href="${LIC_PORTAL}" target="_blank" rel="noopener">Open licence portal ↗</a></div></div>`);
  }
  window.PE_MASTER = { open };

  /* ---------------- licences inside a business's own app ---------------- */
  const myLic = (mid) => O.licences && O.licences.get(mid);
  const isAdminRole = () => O.role === 'Owner' || O.role === 'Admin';

  // owners and admins: a banner on the dashboard when licences need renewing
  const _dash = VIEWS.dashboard;
  VIEWS.dashboard = function () {
    const html = _dash.apply(this, arguments);
    if (!O.ready || !isAdminRole() || !O.licences) return html;
    const people = S.members.filter((m) => !m.archived && !m.placeholder);
    const soon = people.filter((m) => ['expiring', 'grace'].includes(licState(myLic(m.id)).state));
    const gone = people.filter((m) => ['none', 'expired'].includes(licState(myLic(m.id)).state));
    // owners and admins buy here; the master admin manages licences on the licence site
    const buyBtn = O.asMaster
      ? `<a class="btn sm pri lic-btn" href="${LIC_PORTAL}" target="_blank" rel="noopener">${ic('shield', 15)} Manage licences</a>`
      : `<button class="btn sm pri lic-btn" data-act="peBuy">${ic('shield', 15)} Buy or renew licences</button>`;
    let banner;
    if (!soon.length && !gone.length) {
      banner = `<div class="card pad lic-banner ok" role="status">${ic('shield', 18)}<div class="lic-txt small">${plural(people.length, 'staff licence')} active.</div>${buyBtn}</div>`;
    } else {
      const names = (l) => l.slice(0, 4).map((m) => esc(m.name.split(' ')[0])).join(', ') + (l.length > 4 ? ` and ${l.length - 4} more` : '');
      banner = `<div class="card pad lic-banner ${gone.length ? 'bad' : ''}" role="status">${ic('shield', 18)}<div class="lic-txt"><b>${gone.length ? `${plural(gone.length, 'person')} can’t clock in` : `${plural(soon.length, 'licence')} ending soon`}</b><div class="small">${gone.length ? `Licence ended for ${names(gone)}. ` : ''}${soon.length ? `Ending soon: ${names(soon)}. ` : ''}${O.asMaster ? '' : 'Renew online, or contact Proview: <a href="mailto:altun@proviewtech.co.uk">altun@proviewtech.co.uk</a>'}</div></div>${buyBtn}</div>`;
    }
    // the Day / Week / Month bar sits flush at the top of the page, so the banner goes just below it
    const t = document.createElement('template'); t.innerHTML = html;
    const bar = t.content.querySelector('.sublinks');
    if (bar) { bar.insertAdjacentHTML('afterend', banner); return t.innerHTML; }
    return banner + html;
  };

  // owners and admins: buy or renew staff licences online (prices and Stripe links come from the Proview licence portal)
  const BUY_ORDER = ['m1', 'm3', 'm6', 'm12', 'm24', 'm36', 'lifetime'];
  const money = (p) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: (p.currency || 'gbp').toUpperCase() }).format(p.amount / 100);
  A.peBuy = async () => {
    let plans = {};
    try { const { data } = await O.sb.rpc('licence_buy_plans'); plans = data || {}; } catch (e) {}
    const list = Object.entries(plans).sort((a, b) => BUY_ORDER.indexOf(a[0]) - BUY_ORDER.indexOf(b[0]));
    if (!list.length) return toast('Online payment isn’t available yet. Contact Proview: altun@proviewtech.co.uk', 'bad');
    const people = S.members.filter((m) => !m.archived && !m.placeholder && !m._virtual)
      .sort((a, b) => (licOk(myLic(a.id)) - licOk(myLic(b.id))) || String(a.name).localeCompare(b.name));
    const def = (list.find(([k]) => k === 'm12') || list[0])[0];
    openModal(`<div class="pad"><div class="row between"><b style="font-size:17px">Buy or renew licences</b><button class="icon-btn" data-act="closeModal">${ic('x')}</button></div>
      <p class="small mut" style="margin:6px 0 10px">Each person needs their own licence. Choose a plan, then press Pay next to the person. You’ll pay securely with Stripe; time is added on top of any current licence and it updates within about 5 minutes.</p>
      <label class="f">Plan</label><select class="inp" id="peBuyPlan">${list.map(([k, p]) => `<option value="${esc(k)}" ${k === def ? 'selected' : ''}>${esc(p.label || k)} — ${esc(money(p))}</option>`).join('')}</select>
      <div style="margin:12px -24px 0;border-top:1px solid var(--line);max-height:50vh;overflow:auto">${people.map((m) => `<div class="ms-row"><div class="grow"><div class="nm">${esc(m.name || 'Unnamed')}</div><div class="tiny">${esc(m.role || '')}${m.email ? ' · ' + esc(m.email) : ''}</div></div>${licBadge(myLic(m.id) || {})}<button class="btn sm pri" data-act="peBuyGo" data-m="${esc(m.id)}">Pay</button></div>`).join('') || '<div class="ms-empty">No staff yet.</div>'}</div></div>`, 560);
    A.peBuyGo = (el) => {
      const k = $('#peBuyPlan').value, p = plans[k]; if (!p) return;
      const u = new URL(p.link);
      u.searchParams.set('client_reference_id', `${p.ref || 'pve'}__${O.org}__${el.dataset.m}__${k}`);
      if (O.user?.email) u.searchParams.set('prefilled_email', O.user.email);
      window.open(u.toString(), '_blank', 'noopener');
      toast('Finish paying in the Stripe tab. The licence updates within about 5 minutes.');
    };
  };

  // staff home: a heads-up when their own access is about to end
  const _sHome = VIEWS.sHome;
  if (_sHome) VIEWS.sHome = function () {
    const html = _sHome.apply(this, arguments);
    if (!O.ready || !O.myLicence) return html;
    const L = licState(O.myLicence);
    if (L.state === 'grace' || (L.state === 'expiring' && L.daysLeft <= 3)) {
      return `<div class="card pad lic-banner" role="status">${ic('shield', 18)}<div><b>${L.state === 'grace' ? `Your access ends in ${plural(L.graceLeft, 'day')}` : `Your ${L.type === 'trial3' ? 'trial' : 'licence'} ends in ${plural(L.daysLeft, 'day')}`}</b><div class="small">Ask your manager to renew it so you can keep clocking in.</div></div></div>` + html;
    }
    return html;
  };

  // nobody can clock in once their licence has ended (the server refuses too)
  function blocked(id) {
    if (!O.ready || !O.licences || !O.licences.size || licOk(myLic(id))) return false;
    const m = mem(id); toast(`${m && !m.placeholder ? m.name.split(' ')[0] + '’s' : 'This'} Proview Employee licence has ended, so they can’t clock in`, 'bad');
    return true;
  }
  window.peLicenceBlocks = blocked;
  [['clockIn', (el) => el?.dataset?.id || S.me], ['doClockIn', () => (typeof D !== 'undefined' && D && D.member) || S.me], ['kIn', () => (typeof K !== 'undefined' && K && K.mid) || null]].forEach(([n, who]) => {
    const f = A[n]; if (typeof f !== 'function') return;
    A[n] = function (el) { const id = who(el); if (id && blocked(id)) return; return f.apply(this, arguments); };
  });

  // master admins: a shortcut to the licence portal (businesses and licences are managed there)
  const _renderTop = renderTop;
  renderTop = function () {
    _renderTop.apply(this, arguments);
    if (!O.ready || !O.master) return;
    const top = $('#top'); if (!top || top.querySelector('.pe-portal')) return;
    const b = document.createElement('a'); b.className = 'btn sm pe-portal'; b.href = LIC_PORTAL; b.target = '_blank'; b.rel = 'noopener'; b.title = 'Businesses and licences are managed in the licence portal';
    b.innerHTML = ic('shield', 14) + '<span class="hide-sm"> Licence portal ↗</span>';
    const sp = top.querySelector('.sp'); if (sp) sp.after(b); else top.appendChild(b);
  };

  /* ---------------- business picker under the logo (same as Proview Signage's client picker) ---------------- */
  // Master admins see every business (plus a way back to the master page); others see the companies they belong to.
  async function pickLoad() {
    if (pickLoading) return; pickLoading = true;
    try { const { data } = await O.sb.rpc('pe_master_overview'); pickList = (data || []).map((o) => ({ id: o.id, name: o.name })); }
    catch (e) { pickList = []; }
    pickLoading = false; if (O.ready) renderNav();
  }
  function pickItems() {
    const mine = (O.orgs || []).filter((o) => !o.locked).map((o) => ({ id: o.org_id, name: o.org_name }));
    if (!O.master) return mine;
    if (!pickList) { pickLoad(); return mine; }
    const seen = new Set(pickList.map((o) => o.id));
    return [...pickList, ...mine.filter((o) => !seen.has(o.id))];
  }
  function pickHtml(compact) {
    if (!O.ready || !O.org) return '';
    const items = pickItems().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (!O.master && items.length <= 1) return compact ? '' : `<div class="sp-title" title="${esc(S.org?.name || '')}">${esc(S.org?.name || items[0]?.name || '')}</div>`;
    if (!items.some((o) => o.id === O.org)) items.unshift({ id: O.org, name: S.org?.name || 'This business' });
    const all = O.master && U.view === 'allbiz';
    const allOpt = O.master ? `<option value="__all" ${all ? 'selected' : ''}>All sites (${(pickList || items).length})</option>` : '';
    return `${compact ? '' : `<label class="pv-viewing">${all ? 'Master view' : 'Viewing site'}</label>`}<select aria-label="Business" title="Switch business" data-act-change="pePickOrg">${allOpt}${items.map((o) => `<option value="${esc(o.id)}" ${o.id === O.org && !all ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>`;
  }
  A.pePickOrg = (el) => {
    const id = el.value;
    if (id === '__all') { U.view = 'allbiz'; render(); return; }
    if (id && id === O.org && U.view === 'allbiz') { U.view = 'dashboard'; render(); return; }
    if (!id || id === O.org) return;
    if (U.view === 'allbiz') U.view = 'dashboard';
    const mine = (O.orgs || []).find((x) => x.org_id === id && !x.locked);
    const o = (pickList || []).find((x) => x.id === id);
    O.enterOrg(mine || { org_id: id, org_name: o?.name || '', member_id: 'proview-master', role: 'Owner', as_master: true });
  };
  /* ---------------- "All businesses" (master admins, from the picker): every business at a glance ---------------- */
  TITLES.allbiz = 'All businesses';
  const ALLB = { list: null, busy: false, at: 0, err: '' };
  VIEWS.allbiz = function () {
    if (!O.master) return VIEWS.dashboard();
    const L = ALLB.list;
    const staffOf = (b) => (b.staff || []).filter((m) => !m.archived);
    const n = (f) => (L ? L.reduce((t, b) => t + f(b), 0) : '…');
    const stat = (k, v) => `<div class="card stat"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    const ago = (t) => (t ? new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
    const row = (b) => {
      const st = staffOf(b), lic = st.filter((m) => licOk({ type: m.license_type, expires: m.expires_at })).length, logins = st.filter((m) => m.has_login).length;
      const tone = !st.length ? '' : lic === st.length ? 'green' : lic ? 'amber' : 'red';
      return `<tr><td><b>${esc(b.name)}</b>${b.contact_email ? `<div class="small mut">${esc(b.contact_email)}</div>` : ''}${b.suspended ? ' <span class="chip red">Suspended</span>' : ''}</td>
        <td>${st.length}</td><td>${tone ? `<span class="chip ${tone}">${lic} of ${st.length}</span>` : '—'}</td><td>${logins}</td><td class="small mut">${esc(ago(b.last_active))}</td>
        <td style="text-align:right"><button class="btn sm ${b.id === O.org ? '' : 'pri'}" data-act="peAllOpen" data-id="${esc(b.id)}">${b.id === O.org ? 'Back to this business' : 'Open'}</button></td></tr>`;
    };
    const body = !L ? `<div class="pad mut">Loading…</div>`
      : L.length ? `<table class="t"><thead><tr><th>Business</th><th>Staff</th><th>Licensed staff</th><th>Logins</th><th>Last activity</th><th></th></tr></thead><tbody>${L.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).map(row).join('')}</tbody></table>`
      : `<div class="pad mut">No businesses yet. Add them in the licence portal.</div>`;
    return `<div class="stats">${stat('Businesses', L ? L.length : '…')}${stat('Staff', n((b) => staffOf(b).length))}${stat('Licensed staff', n((b) => staffOf(b).filter((m) => licOk({ type: m.license_type, expires: m.expires_at })).length))}${stat('Staff with a login', n((b) => staffOf(b).filter((m) => m.has_login).length))}</div>
      ${ALLB.err ? `<div class="lg-err" role="alert" style="margin-bottom:12px">${esc(ALLB.err)}</div>` : ''}
      <div class="card"><div class="pad row between"><div><b style="font-size:16px">Every business</b><div class="small mut">Staff and licences across all businesses. Open one to see it as its owner does.</div></div><a class="btn sm" href="${LIC_PORTAL}" target="_blank" rel="noopener">Licences ↗</a></div>${body}</div>`;
  };
  AFTER.allbiz = async function () {
    if (!O.master || ALLB.busy || (ALLB.at && Date.now() - ALLB.at < 60e3)) return;
    ALLB.busy = true;
    try { const { data, error } = await O.sb.rpc('pe_master_overview'); if (error) throw error; ALLB.list = data || []; ALLB.err = ''; pickList = ALLB.list.map((o) => ({ id: o.id, name: o.name })); }
    catch (e) { ALLB.err = 'Couldn’t load the businesses: ' + O.friendly(e); ALLB.list = ALLB.list || []; }
    ALLB.at = Date.now(); ALLB.busy = false;
    if (U.view === 'allbiz') render();
  };
  A.peAllOpen = (el) => {
    const id = el.dataset.id; U.view = 'dashboard';
    if (id === O.org) { render(); return; }
    A.pePickOrg({ value: id });
  };

  (function mountPick() {
    const brand = document.querySelector('.side .brand');
    if (brand && !document.getElementById('orgPick')) { const d = document.createElement('div'); d.className = 'client-pick'; d.id = 'orgPick'; brand.after(d); }
  })();
  const _renderNav = renderNav;
  renderNav = function () { _renderNav.apply(this, arguments); const p = document.getElementById('orgPick'); if (p) p.innerHTML = pickHtml(); };
  const _renderTop2 = renderTop;
  renderTop = function () {
    _renderTop2.apply(this, arguments);
    const top = $('#top'); if (!top || !O.ready) return;
    const h = pickHtml(true); if (!h) return;
    const w = document.createElement('span'); w.className = 'top-pick'; w.innerHTML = h;
    const sp = top.querySelector('.sp'); if (sp) sp.after(w); else top.appendChild(w);
  };
  // short names under the icons in the narrow iPad sidebar (same as Proview Bookings)
  const SHORT = { getstarted: 'Start', dashboard: 'Home', timesheets: 'Timesheets', rota: 'Rota', tasks: 'Tasks', live: 'Locations', timeoff: 'Time off', reports: 'Reports', invoices: 'Invoices', ai: 'AI', people: 'People', payslips: 'Payslips', tracking: 'Tracking', schedules: 'Schedules', timeoffset: 'Leave', locations: 'Sites', projects: 'Projects', organization: 'Company',
    sHome: 'Home', sClock: 'Clock', sTasks: 'Tasks', sSheets: 'Timesheets', sP45: 'Payslips' };
  const _renderNav3 = renderNav;
  renderNav = function () {
    _renderNav3.apply(this, arguments);
    // profile box: same design as Proview Bookings and Signage (avatar, name, role · business, chevron)
    const vc = document.getElementById('venueCard');
    if (vc && O.ready) {
      const m = typeof me === 'function' ? me() : null;
      const nm = (e=>String(e||'').split('@')[0].split(/[._-]+/).filter(Boolean).map(w=>w[0].toUpperCase()+w.slice(1)).join(' '))(O.user && O.user.email) || (m && m.name) || 'Me';
      const rl = O.asMaster ? 'Proview admin' : ((m && m.role) || O.role || '');
      vc.className = 'venue side-me';
      vc.innerHTML = `<span class="side-av">${esc(initials(nm))}</span><span class="side-me-t"><b>${esc(nm)}</b><span>${esc([rl, S.org && S.org.name].filter(Boolean).join(' · '))}</span></span>${ic('right', 16)}`;
    }
    // group headers, same style as Proview Bookings (Service / Grow / Team / Manage)
    const nv = document.querySelector('.side .nav');
    if (nv && !nv.querySelector('.nav-sec')) {
      const firstOf = (keys) => keys.map((k) => nv.querySelector(`:scope > button[data-v="${k}"]`)).find(Boolean);
      [['Work', ['getstarted', 'dashboard', 'timesheets', 'rota', 'tasks', 'sHome', 'sClock']], ['Team', ['live', 'timeoff']], ['Insights', ['reports', 'invoices', 'ai']]].forEach(([t, keys]) => {
        const b = firstOf(keys); if (b) b.insertAdjacentHTML('beforebegin', `<div class="nav-sec">${t}</div>`);
      });
    }
    const SIDE_LBL = { payslips: 'Payslips', p45s: 'Payslips', sP45: 'Payslips', tracking: 'Time Tracking', schedules: 'Schedules', timeoffset: 'Holidays', projects: 'Projects', organization: 'Company' };
    document.querySelectorAll('.side .nav button[data-v]').forEach((b) => { const l = b.querySelector('.lbl'); const t = SIDE_LBL[b.dataset.v]; if (l && t) { if (!b.title) b.title = l.textContent; l.textContent = t; } });
    document.querySelectorAll('.side .nav button').forEach((b) => {
      if (b.querySelector('.slbl')) return;
      const v = b.dataset.v, l = b.querySelector('.lbl')?.textContent || '';
      const t = (v && SHORT[v]) || (b.classList.contains('nav-group') ? 'Settings' : l.split(/\s+/)[0]);
      if (t) b.insertAdjacentHTML('beforeend', `<span class="slbl">${esc(t)}</span>`);
      if (b.classList.contains('nav-group') && !b.querySelector('.rail-ic')) b.insertAdjacentHTML('afterbegin', ic('cog', 18).replace('<svg', '<svg class="rail-ic"'));
    });
    document.querySelectorAll('.side-foot button[data-act=signOut]').forEach((b) => { if (!b.querySelector('.slbl')) b.insertAdjacentHTML('beforeend', '<span class="slbl">Sign out</span>'); });
  };
  const css3 = document.createElement('style');
  css3.textContent = `.slbl{display:none}
@media (min-width:701px) and (max-width:900px){.side .nav button{flex-direction:column;gap:4px!important;padding:8px 2px 7px!important;justify-content:center}.side .slbl{display:block;font-size:10.5px;line-height:1.15;font-weight:500;text-align:center;white-space:nowrap;letter-spacing:-.1px}.side .nav button .cnt{display:none}.side-foot button{flex-direction:column;gap:3px;padding:7px 2px!important}.side-foot .slbl{font-size:10px}.side-foot button[data-act=collapse]{display:none!important}}
.client-pick{margin:0 14px 12px}.client-pick:empty{display:none}
.client-pick select,.top-pick select{width:100%;background:#23232a;color:#fff;border:1px solid #33333c;border-radius:9px;padding:9px 30px 9px 11px;font:inherit;font-size:14px;font-weight:500;appearance:none;-webkit-appearance:none;cursor:pointer;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23fff' stroke-width='1.8' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 11px center;text-overflow:ellipsis}
.client-pick select:hover{border-color:#4a4a55}.client-pick select:focus-visible,.top-pick select:focus-visible{outline:2px solid var(--pri);outline-offset:1px}
.client-pick select option{background:#23232a;color:#fff}
.client-pick .sp-title{color:#9a9aa4;font-size:13px;padding:0 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.app.collapsed .client-pick{display:none}.top-pick{display:none}
@media (min-width:701px) and (max-width:900px){.client-pick{display:none}}
@media (max-width:900px){.top-pick{display:block;max-width:46%;min-width:0;margin:0 6px}.top-pick select{padding:7px 28px 7px 10px;font-size:15px;background-color:var(--card);color:var(--ink);border:1px solid var(--line);background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23888' stroke-width='1.8' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")}.top-pick select option{background:var(--card);color:var(--ink)}}
@media (max-width:700px){.top .top-pick{display:none!important}.app .side .client-pick{display:block!important}}
@media (hover:none) and (pointer:coarse){.client-pick select,.top-pick select{font-size:16px}}`;
  document.head.appendChild(css3);

  const css2 = document.createElement('style');
  css2.textContent = `.lic-banner{display:flex;gap:12px;align-items:center;flex-wrap:wrap;border:1px solid #f3d38a;background:#fff8e6;color:#7a5200;margin-bottom:16px}.lic-banner>svg{flex:none;align-self:flex-start;margin-top:2px}.lic-banner .lic-txt{flex:1;min-width:200px}.lic-banner .lic-btn{flex:none;margin-left:auto;text-decoration:none}.lic-banner.ok{border-color:var(--line);background:var(--card);color:var(--ink)}@media (max-width:700px){.lic-banner .lic-btn{width:100%;justify-content:center;margin-left:0;min-height:40px}}.lic-banner.bad{border-color:#f3c7c3;background:#fdf0ef;color:#a02219}.lic-banner a{color:inherit;font-weight:700}`;
  document.head.appendChild(css2);
})();
