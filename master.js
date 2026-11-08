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
     The master lands on "All sites": every business and its sites, with Open buttons.
     Licences are managed at license.proviewcrm.co.uk; a new business can also be started
     here with the app's own create-company flow (it starts on a 3-day trial). */
  const LIC_PORTAL = 'https://license.proviewcrm.co.uk';
  async function open() {
    ALLB.at = 0; ALLB.list = null; ALLB.sites = null;
    O.openHome();
    await loadAll(true);
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

  /* ---------------- site drop-down in the top header (same as Proview WiFi) ----------------
     Right after the page title: "All sites (N)" (master) and "Business ▸ Site", grouped by business.
     Choosing one switches straight away: another business opens it (as the old picker did), a site
     sets the dashboard's location filter (U.fLoc), as "Open" on the All sites page does. */
  async function pickLoad() {
    if (pickLoading) return; pickLoading = true;
    try { await loadAll(false); } catch (e) {}
    pickLoading = false;
  }
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  // the sites (locations) this person may see in the open business
  function mySites() {
    const L = (S.locations || []).filter((l) => !l.archived).slice().sort(byName);
    if (O.asMaster || ['Owner', 'Admin'].includes(O.role)) return L;
    const m = typeof me === 'function' ? me() : null;
    const only = m && Array.isArray(m.sites) && m.sites.length ? m.sites : null;
    return only ? L.filter((l) => only.includes(l.id)) : L;
  }
  // [{ id, name, sites: [{ id, name }] | null }]: sites null = not known (another business of a non-master)
  function pickGroups() {
    const cur = O.org ? { id: O.org, name: S.org?.name || 'This business', sites: mySites() } : null;
    if (O.master) {
      if (!pickList || !ALLB.sites) pickLoad();
      const SI = ALLB.sites || new Map();
      const g = (pickList || []).map((o) => (o.id === O.org && cur ? { ...cur, name: o.name || cur.name } : { id: o.id, name: o.name, sites: (SI.get(o.id) || []).slice().sort(byName) }));
      if (cur && !g.some((o) => o.id === O.org)) g.push(cur);
      return g.sort(byName);
    }
    const g = (O.orgs || []).filter((o) => !o.locked).map((o) => (o.org_id === O.org && cur ? { ...cur, name: o.org_name || cur.name } : { id: o.org_id, name: o.org_name, sites: null }));
    if (cur && !g.some((o) => o.id === O.org)) g.push(cur);
    return g.sort(byName);
  }
  const ARROW = ' ▸ ';
  function pickHtml() {
    if (!O.ready || (!O.org && !O.master)) return '';
    const groups = pickGroups();
    const staff = typeof isStaff === 'function' && isStaff() && !O.asMaster;
    const cur = groups.find((g) => g.id === O.org);
    const one = (t) => `<div class="hdr-pick"><div class="hdr-one" title="${esc(t)}">${esc(t)}</div></div>`;
    // one business, and one site (or staff, who have no business-wide view): the name in the same box
    if (!O.master && groups.length <= 1) {
      if (!cur) return '';
      if (staff || cur.sites.length <= 1) return one(cur.sites.length === 1 ? cur.name + ARROW + cur.sites[0].name : cur.name);
    }
    const all = O.master && (U.view === 'allbiz' || !O.org);
    const here = cur && U.fLoc && cur.sites.some((x) => x.id === U.fLoc) ? U.fLoc : '';
    const sel = (v) => (!all && v === `${O.org}|${here}` ? ' selected' : '');
    const nSites = groups.reduce((t, g) => t + (g.sites ? g.sites.length : 0), 0);
    const opts = groups.map((g) => {
      const list = g.sites || [];
      const whole = O.master ? 'Whole business' : 'All my sites';
      let o;
      if (staff && g.id === O.org) o = `<option value="${esc(g.id)}|"${sel(g.id + '|')}>${esc(g.name)}</option>`;
      else if (!g.sites) o = `<option value="${esc(g.id)}|">${esc(g.name)}</option>`;
      else if (!list.length) o = `<option value="${esc(g.id)}|"${sel(g.id + '|')}>${esc(g.name)}</option>`;
      else o = (list.length > 1 || g.id === O.org ? `<option value="${esc(g.id)}|"${sel(g.id + '|')}>${esc(g.name + ARROW + whole)}</option>` : '')
        + list.map((x) => `<option value="${esc(g.id)}|${esc(x.id)}"${sel(g.id + '|' + x.id)}>${esc(g.name + ARROW + x.name)}</option>`).join('');
      return `<optgroup label="${esc(g.name)}">${o}</optgroup>`;
    }).join('');
    const allOpt = O.master ? `<option value="__all"${all ? ' selected' : ''}>All sites (${nSites})</option>` : '';
    const tip = O.master ? (all ? 'Master view: all sites' : 'Viewing one business as its owner sees it') : 'Switch site';
    return `<div class="hdr-pick"><label class="sr" for="hdr-site">Site</label><select id="hdr-site" aria-label="Site" title="${tip}" data-act-change="pePickSite">${allOpt}${opts}</select></div>`;
  }
  A.pePickSite = (el) => {
    const v = el.value;
    if (v === '__all') return A.pePickOrg({ value: '__all' });
    const i = v.indexOf('|'), id = v.slice(0, i), loc = v.slice(i + 1);
    U.fLoc = loc;
    if (id === O.org) { if (U.view === 'allbiz') U.view = 'dashboard'; render(); return; }
    A.pePickOrg({ value: id });
  };
  A.pePickOrg = (el) => {
    const id = el.value;
    if (id === '__all') { if (O.home) return; U.view = 'allbiz'; render(); return; }
    if (id && id === O.org && U.view === 'allbiz') { U.view = 'dashboard'; render(); return; }
    if (!id || id === O.org) return;
    if (U.view === 'allbiz') U.view = 'dashboard';
    const mine = (O.orgs || []).find((x) => x.org_id === id && !x.locked);
    const o = (pickList || []).find((x) => x.id === id);
    O.enterOrg(mine || { org_id: id, org_name: o?.name || '', member_id: 'proview-master', role: 'Owner', as_master: true });
  };
  /* ---------------- "All sites" (master admins): every business and its sites ----------------
     The master's landing page (no business open, O.home), and also reachable from the picker. */
  TITLES.allbiz = 'All sites';
  const ALLB = { list: null, sites: null, busy: false, at: 0, err: '', siteErr: false };
  U.allQ = U.allQ || '';
  async function loadAll(force) {
    if (!O.master || ALLB.busy || (!force && ALLB.at && Date.now() - ALLB.at < 60e3)) return;
    ALLB.busy = true;
    try {
      const { data, error } = await O.sb.rpc('pe_master_overview'); if (error) throw error;
      ALLB.list = data || []; ALLB.err = '';
      pickList = ALLB.list.map((o) => ({ id: o.id, name: o.name }));
      // anything cached on this device for a business that no longer exists goes
      if (O.purgeCache) O.purgeCache(new Set([...ALLB.list.map((o) => o.id), ...(O.orgs || []).map((o) => o.org_id)]));
    } catch (e) { ALLB.err = 'Couldn’t load the businesses: ' + O.friendly(e); ALLB.list = ALLB.list || []; }
    // sites = "locations" records of each business (the master may read every business)
    try {
      const all = []; let from = 0;
      for (;;) {
        const { data, error } = await O.sb.from('pe_rows').select('org_id,id,data').eq('coll', 'locations').eq('deleted', false).order('org_id').order('id').range(from, from + 999);
        if (error) throw error;
        all.push(...data); if (data.length < 1000) break; from += 1000;
      }
      const by = new Map();
      all.forEach((r) => { if (r.data && r.data.archived) return; if (!by.has(r.org_id)) by.set(r.org_id, []); by.get(r.org_id).push({ id: r.id, name: (r.data && r.data.name) || 'Site', address: (r.data && r.data.address) || '' }); });
      ALLB.sites = by; ALLB.siteErr = false;
    } catch (e) { ALLB.sites = ALLB.sites || new Map(); ALLB.siteErr = true; }
    ALLB.at = Date.now(); ALLB.busy = false;
    if (O.ready && U.view === 'allbiz') render();
    else if (O.ready) { renderNav(); renderTop(); }
  }
  VIEWS.allbiz = function () {
    if (!O.master) return VIEWS.dashboard();
    const L = ALLB.list, SI = ALLB.sites || new Map();
    const staffOf = (b) => (b.staff || []).filter((m) => !m.archived);
    const n = (f) => (L ? L.reduce((t, b) => t + f(b), 0) : '…');
    const stat = (k, v) => `<div class="card stat"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    const ago = (t) => (t ? new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
    const q = String(U.allQ || '').trim().toLowerCase();
    // free 3-day trial: the owner's 'trial3' licence, and no paid licence in the business
    // (trial_ends_at / paid come from pe_master_overview; older servers: worked out from the staff list)
    const trialOf = (b) => {
      let ends = b.trial_ends_at, paid = b.paid;
      if (paid == null) {
        const st = staffOf(b);
        paid = st.some((m) => m.license_type && m.license_type !== 'trial3');
        const t = st.filter((m) => m.role === 'Owner' && m.license_type === 'trial3' && m.expires_at).map((m) => new Date(m.expires_at).getTime());
        ends = t.length ? Math.max(...t) : null;
      }
      if (paid || !ends) return null;
      const at = new Date(ends).getTime();
      return { at, over: at <= Date.now() };
    };
    const trialChip = (b) => {
      const t = trialOf(b); if (!t) return '';
      const when = new Date(t.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
      return t.over ? `<span class="chip red pe-trial" title="Trial ended ${esc(when)}">Trial – expired</span>`
        : `<span class="chip amber pe-trial" title="Free 3-day trial">Trial – ends ${esc(when)}</span>`;
    };
    const lic = (b) => {
      const tc = trialChip(b);
      if (tc) return tc;
      const st = staffOf(b), ok = st.filter((m) => licOk({ type: m.license_type, expires: m.expires_at }));
      if (!st.length) return '<span class="mut">—</span>';
      const tone = ok.length === st.length ? 'green' : ok.length ? 'amber' : 'red';
      const ends = ok.map((m) => (m.license_type === 'lifetime' || !m.expires_at ? Infinity : new Date(m.expires_at).getTime())).filter((t) => t !== Infinity);
      const soon = ends.length ? Math.min(...ends) : null;
      return `<span class="chip ${tone}">${ok.length} of ${st.length} licensed</span>${soon ? `<div class="tiny mut">Next ends ${esc(fmt(soon))}</div>` : ''}`;
    };
    const openBtn = (b, site) => {
      const here = b.id === O.org && !site;
      return `<button class="btn sm ${here ? '' : 'pri'}" data-act="peAllOpen" data-id="${esc(b.id)}"${site ? ` data-loc="${esc(site.id)}"` : ''}>${here ? 'Back to this business' : 'Open'}</button>`;
    };
    const rows = [];
    (L || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).forEach((b) => {
      const sites = (SI.get(b.id) || []).slice().sort((x, y) => String(x.name).localeCompare(String(y.name)));
      const bizHit = !q || [b.name, b.contact_email].some((x) => x && String(x).toLowerCase().includes(q));
      const shown = bizHit ? sites : sites.filter((x) => [x.name, x.address].some((y) => y && String(y).toLowerCase().includes(q)));
      if (!bizHit && !shown.length) return;
      const bizCell = (span) => `<td class="c-biz"${span > 1 ? ` rowspan="${span}"` : ''} style="vertical-align:top"><b>${esc(b.name)}</b>${b.contact_email ? `<div class="small mut">${esc(b.contact_email)}</div>` : ''}${b.suspended ? ' <span class="chip red">Suspended</span>' : ''}<div class="tiny mut">${staffOf(b).length} staff · last active ${esc(ago(b.last_active))}</div></td>`;
      const licCell = (span) => `<td class="c-lic"${span > 1 ? ` rowspan="${span}"` : ''} style="vertical-align:top">${lic(b)}</td>`;
      if (!shown.length) {
        rows.push(`<tr class="pe-first">${bizCell(1)}<td class="c-site mut">${ALLB.siteErr ? 'Sites couldn’t load' : 'No sites yet'}</td>${licCell(1)}<td class="c-open" style="text-align:right">${openBtn(b)}</td></tr>`);
        return;
      }
      shown.forEach((x, i) => rows.push(`<tr${i ? '' : ' class="pe-first"'}>${i ? '' : bizCell(shown.length)}<td class="c-site"><b>${esc(x.name)}</b>${x.address ? `<div class="small mut">${esc(x.address)}</div>` : ''}</td>${i ? '' : licCell(shown.length)}<td class="c-open" style="text-align:right">${openBtn(b, x)}</td></tr>`));
    });
    const nSites = L ? L.reduce((t, b) => t + (SI.get(b.id) || []).length, 0) : '…';
    const many = L && (L.length + (typeof nSites === 'number' ? nSites : 0)) > 6;
    const addBtn = `<button class="btn sm pri" data-act="peAddBiz">${ic('plus', 14)} Add a business</button>`;
    const portalBtn = `<a class="btn sm" href="${LIC_PORTAL}" target="_blank" rel="noopener">Licence portal ↗</a>`;
    const refreshBtn = `<button class="btn sm" data-act="peAllRefresh"${ALLB.busy ? ' disabled' : ''}>${ALLB.busy ? 'Refreshing…' : 'Refresh'}</button>`;
    const body = !L ? `<div class="pad mut">Loading…</div>`
      : !L.length ? `<div class="pad pe-allempty" style="text-align:center;padding:40px 20px">${ic('building', 40)}<div style="font-weight:650;font-size:16px;margin-top:8px">No businesses yet</div><div class="small mut" style="margin:4px auto 14px;max-width:420px">Add a business here (it starts on a 3-day trial), or set up businesses and licences in the Proview licence portal. Press Refresh once it’s done.</div><div class="row" style="gap:8px;justify-content:center;flex-wrap:wrap">${addBtn}${portalBtn}${refreshBtn}</div></div>`
      : rows.length ? `<div class="pe-sites"><table class="t"><thead><tr><th>Business</th><th>Site</th><th>Licence / trial</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
      : `<div class="pad mut">Nothing matches “${esc(U.allQ)}”.</div>`;
    return `<div class="stats">${stat('Businesses', L ? L.length : '…')}${stat('Sites', nSites)}${stat('Staff', n((b) => staffOf(b).length))}${stat('Licensed staff', n((b) => staffOf(b).filter((m) => licOk({ type: m.license_type, expires: m.expires_at })).length))}</div>
      ${ALLB.err ? `<div class="lg-err" role="alert" style="margin-bottom:12px">${esc(ALLB.err)}</div>` : ''}
      <div class="card pe-allsites"><div class="pad row between" style="flex-wrap:wrap;gap:10px"><div><b style="font-size:16px">All sites</b><div class="small mut">Every business and its sites. Open one to see it as its owner does.</div></div><div class="row" style="gap:8px;flex-wrap:wrap">${L && L.length ? addBtn + portalBtn + refreshBtn : ''}</div></div>
      ${many || q ? `<div style="padding:0 14px 12px"><div class="search">${ic('search', 15)}<input class="inp" placeholder="Search businesses and sites…" value="${esc(U.allQ || '')}" data-act-input="allQ" aria-label="Search businesses and sites"></div></div>` : ''}${body}</div>`;
  };
  AFTER.allbiz = function () { loadAll(false); };
  A.peAllRefresh = () => { loadAll(true); render(); };
  A.peAllOpen = (el) => {
    const id = el.dataset.id, loc = el.dataset.loc || '';
    U.fLoc = loc; U.view = 'dashboard';
    if (id === O.org) { render(); return; }
    A.pePickOrg({ value: id });
  };
  // a new business with the app's own create-company flow (the master becomes its owner; 3-day trial)
  A.peAddBiz = () => openModal(`<div class="pad"><div class="row between"><b style="font-size:17px">Add a business</b><button class="icon-btn" data-act="closeModal">${ic('x')}</button></div><p class="small mut" style="margin:6px 0 4px">Creates the business with you as its owner, on a 3-day trial. Add its sites under Locations, and licences in the <a href="${LIC_PORTAL}" target="_blank" rel="noopener">licence portal</a>.</p><label class="f">Business name</label><input class="inp" id="peBizName" placeholder="Business name" autocomplete="organization"><div class="row" style="justify-content:flex-end;gap:8px;margin-top:16px"><button class="btn" data-act="closeModal">Cancel</button><button class="btn pri" data-act="peAddBizGo">Create business</button></div></div>`, 440);
  A.peAddBizGo = async () => {
    const company = ($('#peBizName')?.value || '').trim();
    if (!company) return toast('Enter the business name', 'bad');
    A.closeModal();
    await O.createCompany('Proview', company);
    ALLB.at = 0; pickList = null;
  };
  // on the All sites home there's no business open: only the All sites page, and no business tools
  const _renderNow = renderNow;
  renderNow = function () {
    const home = !!(O.ready && O.home);
    if (home) U.view = 'allbiz';
    document.body.classList.toggle('pe-home', home);
    const r = _renderNow.apply(this, arguments);
    // signed out: only the sign-in page is in the page, no app shell or business data behind it
    if (document.body.classList.contains('signed-out')) ['#content', '#top', '#nav', '#venueCard', '#sideFoot'].forEach((q) => { const el = document.querySelector(q); if (el) el.innerHTML = ''; });
    return r;
  };

  // the drop-down sits right after the page title (one picker only: nothing in the left menu)
  const _renderTop2 = renderTop;
  renderTop = function () {
    _renderTop2.apply(this, arguments);
    const top = $('#top'); if (!top || !O.ready) return;
    top.querySelectorAll('.hdr-pick').forEach((e) => e.remove());
    const h = pickHtml(); if (!h) return;
    const h2 = top.querySelector(':scope > h2');
    if (h2) h2.insertAdjacentHTML('afterend', h); else top.insertAdjacentHTML('afterbegin', h);
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
/* site drop-down in the top header, after the title (same as Proview WiFi's .hdr-pick) */
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
#top .hdr-pick{margin:0 0 0 6px;flex:1 1 auto;min-width:0;max-width:640px;display:flex}
#top .hdr-pick select,#top .hdr-pick .hdr-one{width:100%;min-width:170px;height:38px;box-sizing:border-box;border-radius:10px;border:1px solid var(--line);background-color:var(--card);color:var(--ink);font:600 14px Inter,"Segoe UI",system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif;padding:0 30px 0 12px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#top .hdr-pick .hdr-one{display:block;line-height:36px;padding-right:12px;cursor:default;width:auto;max-width:100%}
#top .hdr-pick select:focus-visible{outline:2px solid #5a8dee;outline-offset:2px}
#top .hdr-pick option,#top .hdr-pick optgroup{background:var(--card);color:var(--ink)}
@media (min-width:701px){#top>h2{flex:0 0 auto;white-space:nowrap}}
/* phone: the status/search/chat/mail/bell tray leaves no room on the title row, so the drop-down
   takes a full-width second row of the header, right under the title */
@media (max-width:700px){#top.top{flex-wrap:wrap!important;row-gap:8px}#top .hdr-pick{order:99;flex:1 1 100%;margin:0;max-width:none}#top .hdr-pick select,#top .hdr-pick .hdr-one{min-width:0;height:36px;font-size:13px}#top .hdr-pick .hdr-one{line-height:34px;width:100%}}
@media (hover:none) and (pointer:coarse){#top .hdr-pick select{font-size:16px}}`;
  document.head.appendChild(css3);

  const css2 = document.createElement('style');
  css2.textContent = `.lic-banner{display:flex;gap:12px;align-items:center;flex-wrap:wrap;border:1px solid #f3d38a;background:#fff8e6;color:#7a5200;margin-bottom:16px}.lic-banner>svg{flex:none;align-self:flex-start;margin-top:2px}.lic-banner .lic-txt{flex:1;min-width:200px}.lic-banner .lic-btn{flex:none;margin-left:auto;text-decoration:none}.lic-banner.ok{border-color:var(--line);background:var(--card);color:var(--ink)}@media (max-width:700px){.lic-banner .lic-btn{width:100%;justify-content:center;margin-left:0;min-height:40px}}.lic-banner.bad{border-color:#f3c7c3;background:#fdf0ef;color:#a02219}.lic-banner a{color:inherit;font-weight:700}`;
  document.head.appendChild(css2);
  const css4 = document.createElement('style');
  css4.textContent = `body.pe-home .side .nav,body.pe-home #tabbar,body.pe-home .clockbox,body.pe-home [data-act=notifs],body.pe-home .hub-chat,body.pe-home .hub-inbox,body.pe-home .side-foot [data-act=kiosk],body.pe-home .top>span[style*="width:1px"]{display:none!important}body.pe-home #venueCard{pointer-events:none}
.pe-allsites .search{max-width:420px}.pe-allsites td .btn{white-space:nowrap}
@media (max-width:700px){.pe-sites table.t,.pe-sites tbody{display:block;min-width:0}.pe-sites thead{display:none}.pe-sites tr{display:flex;flex-wrap:wrap;align-items:center}.pe-sites tr.pe-first{border-top:1px solid var(--line)}.pe-sites td{display:block;border:0!important}
.pe-sites td.c-biz{order:1;flex:1 1 100%;min-width:0;padding-bottom:2px}.pe-sites td.c-lic{order:2;flex:1 1 100%;padding-top:2px;padding-bottom:4px}.pe-sites td.c-lic .tiny{display:inline;margin-left:6px}.pe-sites td.c-site{order:3;flex:1 1 0;min-width:0;padding:6px 10px 6px 22px}.pe-sites td.c-open{order:4;flex:0 0 auto;padding:6px 10px}}`;
  document.head.appendChild(css4);
})();
