/* =====================================================================
   Proview Employee — master admin (Proview) and licence checks
   Same licence rules as Proview Signage, with one licence per staff member:
   no licence until one is bought (no free trials); 1, 3, 6, 12, 24 or 36
   months; lifetime; custom end date (the old 3-day trial can still be set by hand);
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
     here with + Add business (it starts with no licence until one is bought). */
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

  // owners and admins: a banner on the dashboard with the location licences and the staff package
  // (migration 012: each location needs a licence and includes up to 10 staff; people over that need a staff add-on)
  const LS = () => O.licStatus;
  const locOk = (l) => licOk(l);
  const _dash = VIEWS.dashboard;
  VIEWS.dashboard = function () {
    const html = _dash.apply(this, arguments);
    if (!O.ready || !isAdminRole() || !O.licences) return html;
    const buyBtn = O.asMaster
      ? `<a class="btn sm pri lic-btn" href="${LIC_PORTAL}" target="_blank" rel="noopener">${ic('shield', 15)} Manage licences</a>`
      : `<button class="btn sm pri lic-btn" data-act="peBuy">${ic('shield', 15)} Buy or renew licences</button>`;
    const names = (l) => l.slice(0, 4).map((m) => esc(String(m.name || '').split(' ')[0])).join(', ') + (l.length > 4 ? ` and ${l.length - 4} more` : '');
    let banner;
    const st = LS();
    if (st) {
      const locs = (st.locations || []).filter((l) => !l.archived);
      const badLoc = locs.filter((l) => ['none', 'expired'].includes(licState(l).state));
      const soonLoc = locs.filter((l) => ['expiring', 'grace'].includes(licState(l).state));
      const staff = st.staff || [];
      const need = staff.filter((m) => !m.covered);
      const soonAdd = staff.filter((m) => m.addon && !m.package && ['expiring', 'grace'].includes(licState(m).state));
      const pkg = `${st.included} of ${st.allowance} staff included`;
      const bad = badLoc.length || need.length;
      const lines = [
        badLoc.length ? `${badLoc.length === 1 ? esc(badLoc[0].name) + ' has' : plural(badLoc.length, 'location') + ' have'} no working licence: nobody can clock in there. ` : '',
        need.length ? `Over the package, no staff add-on: ${names(need)}. ` : '',
        soonLoc.length ? `Location licence ending soon: ${names(soonLoc)}. ` : '',
        soonAdd.length ? `Staff add-on ending soon: ${names(soonAdd)}. ` : ''].join('');
      banner = `<div class="card pad lic-banner ${bad ? 'bad' : lines ? '' : 'ok'}" role="status">${ic('shield', 18)}<div class="lic-txt"><b>${esc(pkg)}</b><span class="small"> · ${plural(locs.filter((l) => locOk(l)).length, 'licensed location')} (10 staff each)${need.length ? ` · ${plural(need.length, 'person')} need${need.length === 1 ? 's' : ''} a staff add-on` : ''}</span>${lines ? `<div class="small">${lines}${O.asMaster ? '' : 'Buy online, or contact Proview: <a href="mailto:altun@proviewtech.co.uk">altun@proviewtech.co.uk</a>'}</div>` : ''}</div>${buyBtn}</div>`;
    } else {
      // older server (no location licences): one licence per person, as before
      const people = S.members.filter((m) => !m.archived && !m.placeholder);
      const soon = people.filter((m) => ['expiring', 'grace'].includes(licState(myLic(m.id)).state));
      const gone = people.filter((m) => ['none', 'expired'].includes(licState(myLic(m.id)).state));
      if (!soon.length && !gone.length) {
        banner = `<div class="card pad lic-banner ok" role="status">${ic('shield', 18)}<div class="lic-txt small">${plural(people.length, 'staff licence')} active.</div>${buyBtn}</div>`;
      } else {
        banner = `<div class="card pad lic-banner ${gone.length ? 'bad' : ''}" role="status">${ic('shield', 18)}<div class="lic-txt"><b>${gone.length ? `${plural(gone.length, 'person')} can’t clock in` : `${plural(soon.length, 'licence')} ending soon`}</b><div class="small">${gone.length ? `Licence ended for ${names(gone)}. ` : ''}${soon.length ? `Ending soon: ${names(soon)}. ` : ''}${O.asMaster ? '' : 'Renew online, or contact Proview: <a href="mailto:altun@proviewtech.co.uk">altun@proviewtech.co.uk</a>'}</div></div>${buyBtn}</div>`;
      }
    }
    // the Day / Week / Month bar sits flush at the top of the page, so the banner goes just below it
    const t = document.createElement('template'); t.innerHTML = html;
    const bar = t.content.querySelector('.sublinks');
    if (bar) { bar.insertAdjacentHTML('afterend', banner); return t.innerHTML; }
    return banner + html;
  };

  // owners and admins: buy or renew location licences and staff add-ons online (prices and Stripe links come from
  // the Proview licence portal). Stripe client_reference_id (HUB_UNITS.md):
  //   location  pve__loc__<org>__<location>__<plan>      staff add-on  pve__<org>__<member>__<plan>
  const BUY_ORDER = ['m1', 'm3', 'm6', 'm12', 'm24', 'm36', 'lifetime'];
  const money = (p) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: (p.currency || 'gbp').toUpperCase() }).format(p.amount / 100);
  const planSel = (id, plans) => {
    const list = Object.entries(plans || {}).sort((a, b) => BUY_ORDER.indexOf(a[0]) - BUY_ORDER.indexOf(b[0]));
    const def = list.length ? (list.find(([k]) => k === 'm12') || list[0])[0] : '';
    return list.length ? `<select class="inp" id="${id}">${list.map(([k, p]) => `<option value="${esc(k)}" ${k === def ? 'selected' : ''}>${esc(p.label || k)} — ${esc(money(p))}</option>`).join('')}</select>` : '';
  };
  A.peBuy = async () => {
    let kinds = null, flat = {};
    try { const { data, error } = await O.sb.rpc('licence_buy_plans_by_kind'); if (!error) kinds = data; } catch (e) {}
    if (!kinds) { try { const { data } = await O.sb.rpc('licence_buy_plans'); flat = data || {}; } catch (e) {} }
    const st = LS();
    const locPlans = kinds ? kinds.location || {} : {}, staffPlans = kinds ? kinds.staff || {} : flat;
    if (!Object.keys(locPlans).length && !Object.keys(staffPlans).length) return toast('Online payment isn’t available yet. Contact Proview: altun@proviewtech.co.uk', 'bad');
    const row = (title, sub, badge, act, attrs, can) => `<div class="ms-row" style="display:flex;align-items:center;gap:10px;padding:10px 24px;border-bottom:1px solid var(--line)"><div class="grow" style="flex:1;min-width:0"><div class="nm" style="font-weight:600">${esc(title)}</div><div class="tiny">${esc(sub)}</div></div>${badge}${can ? `<button class="btn sm pri" data-act="${act}" ${attrs}>Pay</button>` : ''}</div>`;
    let body;
    if (st) {
      const locs = (st.locations || []).filter((l) => !l.archived).sort((a, b) => locOk(a) - locOk(b) || String(a.name).localeCompare(b.name));
      // people who need an add-on first, then anyone who already has one (to renew)
      const ppl = (st.staff || []).filter((m) => !m.package).sort((a, b) => (a.covered - b.covered) || String(a.name).localeCompare(b.name));
      const hasLoc = Object.keys(locPlans).length, hasStaff = Object.keys(staffPlans).length;
      body = `<p class="small mut" style="margin:6px 0 10px">Each location needs its own licence, which includes up to 10 staff (the earliest joined). Anyone over that needs a staff add-on. You’ll pay securely with Stripe; time is added on top of any current licence and it updates within about 5 minutes.</p>
      <div class="row between" style="margin-top:6px"><b>Locations</b><span class="tiny">${esc(`${st.included} of ${st.allowance} staff included`)}</span></div>
      ${hasLoc ? `<label class="f">Location plan</label>${planSel('peBuyLocPlan', locPlans)}` : '<p class="small mut">Online payment for location licences isn’t available yet: call 020 8935 5495.</p>'}
      <div style="margin:8px -24px 0;border-top:1px solid var(--line)">${locs.map((l) => row(l.name, 'Location · includes 10 staff', licBadge(l), 'peBuyLoc', `data-l="${esc(l.id)}"`, hasLoc && licState(l).state !== 'lifetime')).join('') || '<div class="ms-empty" style="padding:10px 24px">No locations yet.</div>'}</div>
      <div class="row between" style="margin-top:14px"><b>Staff add-ons</b><span class="tiny">${plural(ppl.filter((m) => !m.covered).length, 'person')} need one</span></div>
      ${ppl.length ? (hasStaff ? `<label class="f">Add-on plan</label>${planSel('peBuyPlan', staffPlans)}` : '<p class="small mut">Online payment for staff add-ons isn’t available yet: call 020 8935 5495.</p>') : ''}
      <div style="margin:8px -24px 0;border-top:1px solid var(--line);max-height:40vh;overflow:auto">${ppl.map((m) => row(m.name || 'Unnamed', m.covered ? 'Has a staff add-on' : 'Over the package: needs a staff add-on', m.covered ? licBadge(m) : '<span class="chip red">Needs add-on</span>', 'peBuyGo', `data-m="${esc(m.member_id)}"`, hasStaff && licState(m).state !== 'lifetime')).join('') || '<div class="ms-empty" style="padding:10px 24px">Everyone is included in the package.</div>'}</div>`;
    } else {
      const people = S.members.filter((m) => !m.archived && !m.placeholder && !m._virtual)
        .sort((a, b) => (licOk(myLic(a.id)) - licOk(myLic(b.id))) || String(a.name).localeCompare(b.name));
      body = `<p class="small mut" style="margin:6px 0 10px">Each person needs their own licence. Choose a plan, then press Pay next to the person. You’ll pay securely with Stripe; time is added on top of any current licence and it updates within about 5 minutes.</p>
      <label class="f">Plan</label>${planSel('peBuyPlan', staffPlans)}
      <div style="margin:12px -24px 0;border-top:1px solid var(--line);max-height:50vh;overflow:auto">${people.map((m) => row(m.name || 'Unnamed', `${m.role || ''}${m.email ? ' · ' + m.email : ''}`, licBadge(myLic(m.id) || {}), 'peBuyGo', `data-m="${esc(m.id)}"`, true)).join('') || '<div class="ms-empty" style="padding:10px 24px">No staff yet.</div>'}</div>`;
    }
    openModal(`<div class="pad"><div class="row between"><b style="font-size:17px">Buy or renew licences</b><button class="icon-btn" data-act="closeModal">${ic('x')}</button></div>${body}</div>`, 600);
    const pay = (p, ref) => {
      const u = new URL(p.link);
      u.searchParams.set('client_reference_id', ref);
      if (O.user?.email) u.searchParams.set('prefilled_email', O.user.email);
      window.open(u.toString(), '_blank', 'noopener');
      toast('Finish paying in the Stripe tab. The licence updates within about 5 minutes.');
    };
    A.peBuyGo = (el) => { const k = $('#peBuyPlan')?.value, p = staffPlans[k]; if (p) pay(p, `${p.ref || 'pve'}__${O.org}__${el.dataset.m}__${k}`); };
    A.peBuyLoc = (el) => { const k = $('#peBuyLocPlan')?.value, p = locPlans[k]; if (p) pay(p, `${p.ref || 'pve'}__loc__${O.org}__${el.dataset.l}__${k}`); };
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
  function blocked(id, locId) {
    if (!O.ready) return false;
    const st = LS(), m = mem(id), who = m && !m.placeholder ? m.name.split(' ')[0] : 'This person';
    if (st) {
      // migration 012: the location must be licensed, and the person included in the package or on a staff add-on
      const l = locId && (st.locations || []).find((x) => x.id === locId);
      if (l && !locOk(l)) { toast(`${l.name} has no Proview Employee licence yet, so nobody can clock in there`, 'bad'); return true; }
      const p = (st.staff || []).find((x) => x.member_id === id) || (st.me && st.me.member_id === id ? st.me : null);
      if (p && !p.covered) { toast(`${who} isn’t included in the staff package and has no staff add-on, so they can’t clock in`, 'bad'); return true; }
      return false;
    }
    if (!O.licences || !O.licences.size || licOk(myLic(id))) return false;
    toast(`${m && !m.placeholder ? m.name.split(' ')[0] + '’s' : 'This'} Proview Employee licence has ended, so they can’t clock in`, 'bad');
    return true;
  }
  window.peLicenceBlocks = blocked;
  const dLoc = () => (typeof D !== 'undefined' && D && D.location) || '';
  [['clockIn', (el) => el?.dataset?.id || S.me, () => ''], ['doClockIn', () => (typeof D !== 'undefined' && D && D.member) || S.me, dLoc], ['kIn', () => (typeof K !== 'undefined' && K && K.mid) || null, () => '']].forEach(([n, who, where]) => {
    const f = A[n]; if (typeof f !== 'function') return;
    A[n] = function (el) { const id = who(el); if (id && blocked(id, where(el))) return; return f.apply(this, arguments); };
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
    const box = (t) => `<div class="hdr-pick"><label class="sr" for="hdr-site">Location</label><select id="hdr-site" aria-label="Choose location" title="${esc(t)}" disabled><option>${esc(t)}</option></select></div>`;
    // one business with one site (or staff, who have no business-wide view): its name, in the same box, disabled
    if (!O.master && groups.length <= 1) {
      if (!cur) return '';
      if (staff || cur.sites.length <= 1) return box(cur.sites.length === 1 ? cur.sites[0].name : cur.name);
    }
    const all = O.master && (U.view === 'allbiz' || !O.org);
    const here = cur && U.fLoc && cur.sites.some((x) => x.id === U.fLoc) ? U.fLoc : '';
    const sel = (v) => (!all && v === `${O.org}|${here}` ? ' selected' : '');
    const opt = (v, t) => `<option value="${esc(v)}"${sel(v)}>${esc(t)}</option>`;
    const nSites = groups.reduce((t, g) => t + (g.sites ? g.sites.length : 0), 0);
    let opts;
    if (!O.master && groups.length === 1) {
      // one business: "All my sites (N)" + each of their sites, no business prefix
      opts = opt(cur.id + '|', `All my locations (${cur.sites.length})`) + cur.sites.map((x) => opt(cur.id + '|' + x.id, x.name)).join('');
    } else if (O.master) {
      // master (owner's simpler list): just the site names, sorted; " · Business" only when two share a name.
      // Businesses with no sites aren't listed (they're on the All sites page, as is each business's whole view).
      const list = [];
      groups.forEach((g) => (g.sites || []).forEach((x) => list.push({ v: g.id + '|' + x.id, name: x.name, biz: g.name })));
      const dup = new Map(); list.forEach((x) => { const k = String(x.name).trim().toLowerCase(); dup.set(k, (dup.get(k) || 0) + 1); });
      list.forEach((x) => { x.t = dup.get(String(x.name).trim().toLowerCase()) > 1 ? x.name + ' · ' + x.biz : x.name; });
      list.sort((a, b) => String(a.t).localeCompare(String(b.t)));
      // a whole business opened from the All sites page has no entry: show it as the (hidden) current choice
      const curV = `${O.org}|${here}`;
      opts = (!all && cur && !list.some((x) => x.v === curV) ? `<option value="${esc(curV)}" hidden selected>${esc(cur.name + ' (all locations)')}</option>` : '')
        + list.map((x) => opt(x.v, x.t)).join('');
    } else {
      // someone in several businesses: one group per business, "Business ▸ All my sites" first
      const whole = O.master ? 'All locations' : 'All my locations';
      opts = groups.map((g) => {
        const o = staff && g.id === O.org ? opt(g.id + '|', g.name)
          : opt(g.id + '|', g.name + ARROW + whole) + (g.sites || []).map((x) => opt(g.id + '|' + x.id, g.name + ARROW + x.name)).join('');
        return `<optgroup label="${esc(g.name)}">${o}</optgroup>`;
      }).join('');
    }
    const allOpt = O.master ? `<option value="__all"${all ? ' selected' : ''}>All locations (${nSites})</option>` : '';
    const curT = ((allOpt + opts).match(/<option [^>]*selected[^>]*>([^<]*)<\/option>/) || [])[1] || '';
    return `<div class="hdr-pick"><label class="sr" for="hdr-site">Location</label><select id="hdr-site" aria-label="Choose location"${curT ? ` title="${curT}"` : ''} data-act-change="pePickSite">${allOpt}${opts}</select></div>`;
  }
  // the chosen site is remembered per person, per business, on this device (cleared at sign-out, see cloud.js)
  const siteKey = (org) => (O.user && org ? `pe-site:${O.user.id}:${org}` : '');
  function saveSite() { const k = siteKey(O.org); if (!k) return; try { localStorage.setItem(k, JSON.stringify(U.fLoc || '')); } catch (e) {} }
  function savedSite(org) { try { return JSON.parse(localStorage.getItem(siteKey(org)) || '""') || ''; } catch (e) { return ''; } }
  let siteOrg = null, siteChosen = false;
  function syncSite() {
    if (!O.ready || !O.org || O.home) { siteOrg = null; return; }
    if (O.org !== siteOrg) {
      // another business opened: use the site just chosen, else the one remembered (if it still exists), else all
      siteOrg = O.org;
      if (!siteChosen) U.fLoc = savedSite(O.org);
      siteChosen = false;
      if (U.fLoc && !mySites().some((x) => x.id === U.fLoc)) U.fLoc = '';
    }
    saveSite();
  }
  A.pePickSite = (el) => {
    const v = el.value;
    if (v === '__all') return A.pePickOrg({ value: '__all' });
    const i = v.indexOf('|'), id = v.slice(0, i), loc = v.slice(i + 1);
    U.fLoc = loc; siteChosen = id !== O.org;
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
  TITLES.allbiz = 'Locations';
  const ALLB = { list: null, sites: null, inNow: null, busy: false, at: 0, err: '', siteErr: false };
  // Location licences and the staff package (migration 012; older servers send neither, then the old per-person rules):
  // a person is fine if covered (in the package or on a valid staff add-on); a location needs its own licence.
  const ALL_NEEDS = ['none', 'expiring', 'grace', 'expired'];
  const mLic = (m) => ({ type: m.license_type, expires: m.expires_at });
  const staffOk = (m) => (m.covered != null ? !!m.covered : licOk(mLic(m)));
  const staffAttn = (m) => (m.covered != null ? (!m.covered || (!m.package && ['expiring', 'grace'].includes(licState(mLic(m)).state))) : ALL_NEEDS.includes(licState(mLic(m)).state));
  const locsOf = (b) => (b.locations || []).filter((l) => !l.archived);
  const locAttn = (l) => ALL_NEEDS.includes(licState(l).state);
  const staffPill = (m) => {
    if (m.covered != null && !m.covered) return '<span class="ov-pill bad">Needs staff add-on</span>';
    if (m.package) return '<span class="ov-pill ok">Included</span>';
    const s = licSummary(mLic(m)); return `<span class="ov-pill ${{ green: 'ok', amber: 'warn', red: 'bad' }[s.tone] || ''}">${esc(s.text)}</span>`;
  };
  const locPill = (l) => { const s = licSummary(l); return `<span class="ov-pill ${{ green: 'ok', amber: 'warn', red: 'bad' }[s.tone] || ''}">${esc(s.L.state === 'none' ? 'No licence' : s.text)}</span>`; };
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
      all.forEach((r) => { if (r.data && r.data.archived) return; if (!by.has(r.org_id)) by.set(r.org_id, []); by.get(r.org_id).push({ id: r.id, name: (r.data && r.data.name) || 'Location', address: (r.data && r.data.address) || '' }); });
      ALLB.sites = by; ALLB.siteErr = false;
    } catch (e) { ALLB.sites = ALLB.sites || new Map(); ALLB.siteErr = true; }
    // who is clocked in now: open time entries (no clock-out yet), as the app's own in/out status
    try {
      const { data, error } = await O.sb.from('pe_rows').select('org_id,member_id,data').eq('coll', 'entries').eq('deleted', false).is('data->>out', null).limit(5000);
      if (error) throw error;
      const by = new Map();
      (data || []).forEach((r) => { const d = r.data || {}; if (d.out != null) return; const mid = d.member || r.member_id; if (!mid) return; if (!by.has(r.org_id)) by.set(r.org_id, new Map()); by.get(r.org_id).set(mid, d.location || ''); });
      ALLB.inNow = by;
    } catch (e) { ALLB.inNow = null; }
    ALLB.at = Date.now(); ALLB.busy = false;
    if (O.ready && U.view === 'allbiz') render();
    else if (O.ready) { renderNav(); renderTop(); }
  }
  VIEWS.allbiz = function () {
    if (!O.master) return VIEWS.dashboard();
    // Proview Signage's Locations page (business cards and clickable summary boxes; LOCATIONS_PAGE_STANDARD)
    const L = ALLB.list, SI = ALLB.sites || new Map(), IN = ALLB.inNow;
    const staffOf = (b) => (b.staff || []).filter((m) => !m.archived);
    const sitesOf = (b) => (SI.get(b.id) || []).slice().sort((x, y) => String(x.name).localeCompare(String(y.name)));
    const inOf = (b) => (IN ? staffOf(b).filter((m) => IN.get(b.id)?.has(m.member_id)) : null);
    const lic = (m) => ({ type: m.license_type, expires: m.expires_at });
    const NEEDS = ['none', 'expiring', 'grace', 'expired'];
    const fmtD = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const nn = (f) => (L ? L.reduce((t, b) => t + f(b), 0) : '…');
    // an existing trial (from before 11 Nov 2026): the owner's 'trial3' licence, and no paid licence in the business
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
    // never licensed (a new business: no free trials): no licence type or end date anywhere in it
    // (licensed_ever comes from pe_master_overview, migration 009; older servers: worked out from the staff list)
    const noLic = (b) => (b.licensed_ever != null ? !b.licensed_ever : !(b.staff || []).some((m) => m.license_type || m.expires_at));
    // status pill: grey nothing set up yet · red no licence / expired / suspended · amber trial, grace or ending soon · green all good
    const pill = (b) => {
      const st = staffOf(b), t = trialOf(b);
      if (b.suspended) return '<span class="ov-pill bad">Suspended</span>';
      if (noLic(b)) return '<span class="ov-pill bad">No licence</span>';
      if (t) return t.over ? '<span class="ov-pill bad">Trial – expired</span>' : `<span class="ov-pill warn">Trial – ends ${esc(fmtD(t.at))}</span>`;
      const ls = locsOf(b);
      if (ls.length && ls.every((l) => licState(l).state === 'none')) return '<span class="ov-pill bad">No location licence</span>';
      const lb = ls.filter(locAttn).length;
      if (lb) return `<span class="ov-pill ${ls.some((l) => ['none', 'expired'].includes(licState(l).state)) ? 'bad' : 'warn'}">${lb} location licence${lb === 1 ? ' needs' : 's need'} attention</span>`;
      if (b.allowance != null) {
        const need = st.filter((m) => m.covered === false).length;
        if (need) return `<span class="ov-pill bad">${need} need${need === 1 ? 's' : ''} a staff add-on</span>`;
      }
      const bad = st.filter((m) => m.covered == null && ['none', 'expired'].includes(licState(lic(m)).state)).length;
      if (bad) return `<span class="ov-pill bad">${bad} licence${bad === 1 ? ' needs' : 's need'} attention</span>`;
      const warn = st.filter((m) => !m.package && ['grace', 'expiring'].includes(licState(lic(m)).state)).length;
      if (warn) return `<span class="ov-pill warn">${warn} licence${warn === 1 ? '' : 's'} ending soon</span>`;
      if (!st.length) return '<span class="ov-pill">No staff yet</span>';
      if (!sitesOf(b).length) return '<span class="ov-pill">No locations yet</span>';
      return '<span class="ov-pill ok">All good</span>';
    };
    // footer licence text, as Signage: "Licences: lifetime", "2 licences", "Trial ends 12 Nov", "Expired"
    const licText = (b) => {
      const st = staffOf(b), t = trialOf(b);
      if (noLic(b)) return 'No licence yet';
      if (t) return t.over ? 'Trial expired' : `Trial ends ${fmtD(t.at)}`;
      if (b.allowance != null && locsOf(b).length) {
        const ls = locsOf(b), okL = ls.filter((l) => licOk(l)).length, inc = st.filter((m) => m.package).length;
        if (ls.every((l) => licState(l).state === 'lifetime') && st.every((m) => m.package || licState(lic(m)).state === 'lifetime')) return 'Licences: lifetime';
        return `${okL} of ${ls.length} location${ls.length === 1 ? '' : 's'} licensed · ${inc} of ${b.allowance} staff included`;
      }
      if (!st.length) return 'Add staff to get started';
      if (st.every((m) => licState(lic(m)).state === 'lifetime')) return 'Licences: lifetime';
      if (st.every((m) => licState(lic(m)).state === 'expired')) return 'Expired';
      const ok = st.filter((m) => licOk(lic(m))).length;
      return ok === st.length ? `${st.length} licence${st.length === 1 ? '' : 's'}` : `${ok} of ${st.length} licensed`;
    };
    const staffLine = (b) => { const st = staffOf(b).length, i = inOf(b); return !st ? 'No staff yet' : `${st} staff${i ? ` · ${i.length} clocked in` : ''}`; };
    const chev = '<span class="ov-chev" aria-hidden="true">›</span>';
    const cards = (L || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).map((b) => {
      const sites = sitesOf(b), single = sites.length === 1;
      const sub = single ? [sites[0].name !== b.name && sites[0].name, staffLine(b)].filter(Boolean).join(' · ')
        : `${sites.length ? `${sites.length} locations` : ALLB.siteErr ? 'Locations couldn’t load' : 'No locations yet'} · ${staffLine(b)}`;
      const rows = single ? '' : sites.map((x) => {
        const n = IN ? staffOf(b).filter((m) => IN.get(b.id)?.get(m.member_id) === x.id).length : null;
        const ll = locsOf(b).find((l) => l.id === x.id);
        return `<button type="button" class="ov-loc" data-act="peAllOpen" data-id="${esc(b.id)}" data-loc="${esc(x.id)}" title="Open on this location"><span class="ov-dot${n ? ' ok' : ''}"></span><span class="grow">${esc(x.name)}</span><span class="muted small">${n == null ? '' : `${n} clocked in`}</span>${ll && locAttn(ll) ? locPill(ll) : ''}${chev}</button>`;
      }).join('');
      const q = [b.name, b.contact_email, ...sites.map((x) => x.name), ...sites.map((x) => x.address)].filter(Boolean).join(' ').toLowerCase();
      return { q, html: `<article class="card ov-biz"><div class="ov-bh"><div class="grow"><h3>${esc(b.name)}</h3><div class="muted small">${esc(sub)}</div></div>${pill(b)}</div>${rows}<div class="ov-bf"><span class="muted small">${esc(licText(b))}</span><button class="btn sm primary" data-act="peAllOpen" data-id="${esc(b.id)}"${single ? ` data-loc="${esc(sites[0].id)}"` : ''}>Open business</button></div></article>` };
    });
    const nSites = L ? L.reduce((t, b) => t + (SI.get(b.id) || []).length, 0) : '…';
    const nStaff = nn((b) => staffOf(b).length), nIn = IN ? nn((b) => inOf(b).length) : '—';
    const nLic = nn((b) => staffOf(b).filter(staffOk).length), nAttn = nn((b) => staffOf(b).filter(staffAttn).length + locsOf(b).filter(locAttn).length);
    const stat = (k, v, list, tone) => `<button type="button" class="card ov-stat${tone ? ' ' + tone : ''}" data-act="peAllList" data-list="${list}" title="Show the list"><div class="tiny">${k}</div><div class="ov-v">${v}</div></button>`;
    const stats = `<div class="ov-stats">${stat('Businesses', L ? L.length : '…', 'biz')}${stat('Locations', nSites, 'loc')}${stat('Staff', nStaff, 'staff')}${stat('Clocked in now', nIn, 'in', nIn > 0 ? 'ok' : '')}${stat('Licensed staff', nLic, 'lic')}${stat('Licences need attention', nAttn, 'attn', nAttn > 0 ? 'bad' : '')}</div>`;
    const addBtn = `<button class="btn primary" data-act="peAddBiz">${ic('plus', 16)} Add business</button>`;
    const portalBtn = `<a class="btn" href="${LIC_PORTAL}" target="_blank" rel="noopener">Licences ↗</a>`;
    const refreshBtn = `<button class="btn" data-act="peAllRefresh" title="Refresh"${ALLB.busy ? ' disabled' : ''}>${ic('refresh', 16)} ${ALLB.busy ? 'Refreshing…' : 'Refresh'}</button>`;
    const q = String(U.allQ || '').trim().toLowerCase();
    const shown = cards.filter((c) => !q || c.q.includes(q)).map((c) => c.html);
    const body = !L ? '<p class="muted" style="grid-column:1/-1;margin:0">Loading…</p>'
      : !L.length ? `<div class="card ov-empty-card"><div style="display:flex;flex-direction:column;align-items:center;text-align:center;padding:28px 12px;gap:10px"><h3 style="margin:0;font-size:15px;font-weight:650">No businesses yet</h3><p class="muted" style="margin:0">Add a business here (it starts with no licence until one is bought), or set up businesses and licences in the Proview licence portal. Press Refresh once it’s done.</p><div class="pv-acts" style="justify-content:center">${addBtn}<a class="btn" href="${LIC_PORTAL}" target="_blank" rel="noopener">Open licence portal ↗</a>${refreshBtn}</div></div></div>`
      : shown.length ? shown.join('') : `<p class="muted" style="grid-column:1/-1;margin:0">No businesses or locations match “${esc(String(U.allQ || '').trim())}”.</p>`;
    return `<div class="pv-loc"><div class="pv-ph"><p class="muted">Every business on the platform with its locations. Open one to see it as its team does.</p><div class="pv-acts">${refreshBtn}${portalBtn}${addBtn}</div></div>
      ${stats}
      ${ALLB.err ? `<div class="lg-err" role="alert" style="margin-bottom:12px">${esc(ALLB.err)}</div>` : ''}
      <div class="ov-tools"><input class="ov-search" type="search" placeholder="Search businesses or locations" aria-label="Search businesses or locations" value="${esc(U.allQ || '')}" data-act-input="allQ"></div>
      <div class="ov-grid">${body}</div></div>`;
  };
  // the summary boxes: each opens the list behind its number (as Proview Signage)
  A.peAllList = (el) => {
    const k = el.dataset.list, L = ALLB.list || [], SI = ALLB.sites || new Map(), IN = ALLB.inNow;
    const staffOf = (b) => (b.staff || []).filter((m) => !m.archived);
    const lic = (m) => ({ type: m.license_type, expires: m.expires_at });
    const NEEDS = ['none', 'expiring', 'grace', 'expired'];
    const chev = '<span class="ov-chev" aria-hidden="true">›</span>';
    const tone = (m) => { if (m.covered != null) return !m.covered ? 'bad' : staffAttn(m) ? 'warn' : 'ok'; const s = licState(lic(m)).state; return s === 'none' || s === 'expired' ? 'bad' : s === 'grace' || s === 'expiring' ? 'warn' : 'ok'; };
    const pillOf = (m) => staffPill(m);
    const biz = L.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const people = biz.flatMap((b) => staffOf(b).map((m) => ({ b, m })));
    const locName = (b, id) => (SI.get(b.id) || []).find((x) => x.id === id)?.name || '';
    const li = (b, loc, dotT, title, sub, right) => `<button type="button" class="ov-li" data-act="peAllOpen" data-id="${esc(b.id)}"${loc ? ` data-loc="${esc(loc)}"` : ''}><span class="ov-dot ${dotT}"></span><span class="grow"><b>${esc(title)}</b><span class="tiny" style="display:block">${esc(sub)}</span></span>${right}${chev}</button>`;
    const person = ({ b, m }, right) => li(b, '', tone(m), m.name || m.email || 'Staff member', [b.name, m.role].filter(Boolean).join(' · '), right);
    let title, items, empty;
    if (k === 'biz') { title = 'Businesses'; empty = 'No businesses yet.'; items = biz.map((b) => li(b, '', staffOf(b).some((m) => tone(m) === 'bad') ? 'bad' : staffOf(b).some((m) => tone(m) === 'warn') ? 'warn' : staffOf(b).length ? 'ok' : '', b.name, `${(SI.get(b.id) || []).length} location(s) · ${staffOf(b).length} staff`, '')); }
    else if (k === 'loc') { title = 'Locations'; empty = 'No locations yet.'; items = biz.flatMap((b) => (SI.get(b.id) || []).slice().sort((x, y) => String(x.name).localeCompare(String(y.name))).map((x) => { const n = IN ? staffOf(b).filter((m) => IN.get(b.id)?.get(m.member_id) === x.id).length : null; return li(b, x.id, n ? 'ok' : '', x.name, b.name, n == null ? '' : `<span class="muted small">${n} clocked in</span>`); })); }
    else if (k === 'staff') { title = 'Staff'; empty = 'No staff yet.'; items = people.map((p) => person(p, pillOf(p.m))); }
    else if (k === 'in') { title = 'Clocked in now'; empty = IN ? 'Nobody is clocked in right now.' : 'Couldn’t load who is clocked in. Press Refresh.'; items = IN ? people.filter(({ b, m }) => IN.get(b.id)?.has(m.member_id)).map(({ b, m }) => li(b, IN.get(b.id).get(m.member_id) || '', 'ok', m.name || m.email || 'Staff member', [b.name, locName(b, IN.get(b.id).get(m.member_id))].filter((x, i, a) => x && a.indexOf(x) === i).join(' · '), '<span class="muted small">Clocked in</span>')) : []; }
    else if (k === 'lic') { title = 'Licensed staff'; empty = 'Nobody has a working licence.'; items = people.filter(({ m }) => staffOk(m)).map((p) => person(p, pillOf(p.m))); }
    else {
      title = 'Licences needing attention'; empty = 'Every licence is fine.';
      items = [...biz.flatMap((b) => locsOf(b).filter(locAttn).map((l) => li(b, l.id, 'bad', l.name, `${b.name} · location licence`, locPill(l)))),
        ...people.filter(({ m }) => staffAttn(m)).map((p) => person(p, pillOf(p.m)))];
    }
    openModal(`<div class="pad"><div class="row between"><b style="font-size:17px">${esc(title)}</b><button class="icon-btn" data-act="closeModal" aria-label="Close">${ic('x')}</button></div>${items.length ? `<div class="ov-list" style="margin-top:8px">${items.join('')}</div>` : `<p class="small mut" style="margin:10px 0 0">${empty}</p>`}</div>`, 640);
  };
  AFTER.allbiz = function () { loadAll(false); };
  A.peAllRefresh = () => { loadAll(true); render(); };
  A.peAllOpen = (el) => {
    const id = el.dataset.id, loc = el.dataset.loc || '';
    if ($('#modal')?.classList.contains('show')) A.closeModal();
    U.fLoc = loc; U.view = 'dashboard'; siteChosen = id !== O.org;
    if (id === O.org) { render(); return; }
    A.pePickOrg({ value: id });
  };
  // "+ Add business" (master only), design D (11 Nov 2026): business + owner in one grid, then two choices.
  //   How will they sign in?  invite (email link, they choose the password) | set a password now (no email)
  //   Licence                 none yet | 3-day trial (pe_master_trial, migration 011) | set it now (licence portal)
  // pe_add_business (supabase/008) does the business, location and owner all-or-nothing on the server. For an invite the
  // login gets a random password nobody sees and Supabase emails a set-your-password link (the app's PASSWORD_RECOVERY
  // flow asks them to choose one).
  const abReq = (t) => `${t}<span style="color:#d92d20"> *</span>`;
  const abRand = (n) => { const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789', r = crypto.getRandomValues(new Uint32Array(n)); return [...r].map((x) => a[x % a.length]).join(''); };
  const abOpt = (name, val, title, sub, on, badge) => `<label class="pe-abz-opt${on ? ' on' : ''}"><input type="radio" name="${name}" value="${val}"${on ? ' checked' : ''}><span class="t"><b>${title}</b><span>${sub}</span></span>${badge ? `<span class="pe-abz-badge">${badge}</span>` : ''}</label>`;
  A.peAddBiz = () => {
    if (!O.master) return;
    openModal(`<div class="pad pe-abz"><div class="row between"><b style="font-size:20px">Add business</b><button class="icon-btn" data-act="closeModal" aria-label="Close">${ic('x')}</button></div>
      <div class="pe-abz-grid">
        <div><label class="f" for="peAbBiz">${abReq('Business name')}</label><input class="inp" id="peAbBiz" placeholder="e.g. Tolians" autocomplete="off"></div>
        <div><label class="f" for="peAbName">${abReq('Owner’s name')}</label><input class="inp" id="peAbName" placeholder="e.g. Sam Taylor" autocomplete="off"></div>
        <div><label class="f" for="peAbEmail">${abReq('Owner’s email')}</label><input class="inp" id="peAbEmail" type="email" placeholder="name@company.com" autocomplete="off"></div>
        <div><label class="f" for="peAbMob">Mobile <span class="mut" style="font-weight:400">(optional)</span></label><input class="inp" id="peAbMob" type="tel" placeholder="07…" autocomplete="off"></div></div>
      <fieldset class="pe-abz-set"><legend>How will they sign in?</legend>
        ${abOpt('peAbSi', 'invite', 'Email them an invite', 'They get an email link and choose their own password.', true, 'Recommended')}
        ${abOpt('peAbSi', 'pw', 'Set a password now', 'No email is sent. You pass the password on yourself.', false)}
        <div class="pe-abz-pwrow" id="peAbPwRow" hidden><label class="f" for="peAbPw">${abReq('Password')}</label><div class="pe-abz-pw"><div class="pw2"><input class="inp" id="peAbPw" type="password" placeholder="At least 6 characters" autocomplete="new-password"><button type="button" class="pw2-eye" data-act="peAbEye" aria-label="Show password" title="Show password">${ic('eye', 18)}</button></div><button class="btn sm" type="button" data-act="peAbSuggest">Suggest</button></div></div>
      </fieldset>
      <fieldset class="pe-abz-set"><legend>Licence</legend><div class="pe-abz-lic">
        ${abOpt('peAbLic', 'none', 'None yet', 'They buy one when they sign in.', true)}
        ${abOpt('peAbLic', 'trial', '3-day trial', 'Full access for 3 days, then it locks.', false)}
        ${abOpt('peAbLic', 'set', 'Set it now', 'Then set it in the licence portal.', false)}</div>
      </fieldset>
      <div class="pe-abz-foot"><span class="small mut">Adds the business and a location with the same name.</span><button class="btn" data-act="closeModal">Cancel</button><button class="btn pri" id="peAbGo" data-act="peAddBizGo">Add and send invite</button></div></div>`, 660);
    const box = document.querySelector('#modal .pe-abz');
    box.addEventListener('change', (ev) => {
      const t = ev.target; if (!t || t.type !== 'radio') return;
      box.querySelectorAll(`input[name="${t.name}"]`).forEach((r) => r.closest('.pe-abz-opt').classList.toggle('on', r.checked));
      if (t.name === 'peAbSi') { const pw = t.value === 'pw'; $('#peAbPwRow').hidden = !pw; $('#peAbGo').textContent = pw ? 'Add business' : 'Add and send invite'; if (pw) $('#peAbPw').focus(); }
    });
    $('#peAbBiz').focus();
  };
  const abShow = (show) => { const i = $('#peAbPw'), b = document.querySelector('#modal [data-act=peAbEye]'); if (!i) return; i.type = show ? 'text' : 'password'; if (b) { b.classList.toggle('on', show); b.title = show ? 'Hide password' : 'Show password'; b.setAttribute('aria-label', b.title); } };
  A.peAbEye = () => { const i = $('#peAbPw'); if (!i) return; abShow(i.type === 'password'); i.focus(); };
  A.peAbSuggest = () => { const i = $('#peAbPw'); if (!i) return; i.value = abRand(10); abShow(true); };
  const abCopy = async (text) => { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch (e) { prompt('Copy this:', text); } };
  A.peAddBizGo = async () => {
    if (!O.master) return;   // only the master adds businesses
    const v = (id) => ($('#' + id)?.value || '').trim(), need = (id, msg) => { toast(msg, 'bad'); $('#' + id)?.focus(); };
    const pick = (n) => document.querySelector(`#modal input[name="${n}"]:checked`)?.value;
    const biz = v('peAbBiz'), name = v('peAbName'), e = v('peAbEmail').toLowerCase(), mob = v('peAbMob');
    const invite = pick('peAbSi') !== 'pw', lic = pick('peAbLic') || 'none';
    const pw = invite ? abRand(24) : ($('#peAbPw')?.value || '');
    if (biz.length < 2) return need('peAbBiz', 'Enter the business name');
    if (name.length < 2) return need('peAbName', 'Enter the owner’s name');
    if (!/^\S+@\S+\.\S+$/.test(e)) return need('peAbEmail', 'Enter a valid email address');
    if (!invite && pw.length < 6) return need('peAbPw', 'The password needs at least 6 characters');
    const btn = $('#peAbGo'); if (btn) btn.disabled = true;
    const { data: r, error } = await O.sb.rpc('pe_add_business', { p_business: biz, p_name: name, p_email: e, p_mobile: mob, p_password: pw });
    if (error || !r) { if (btn) btn.disabled = false; toast(O.friendly(error || { message: 'Couldn’t add the business' }), 'bad'); return; }
    // licence: 3-day trial now (never replaces a licence already set)
    let licLine = '';
    if (lic === 'trial') {
      const { data: t, error: te } = await O.sb.rpc('pe_master_trial', { p_org: r.org_id });
      licLine = te ? `<p class="pe-abz-warn">The business was added, but the trial couldn’t be started: ${esc(O.friendly(te))}. Set a licence in the licence portal.</p>`
        : t && t.applied ? `<p class="pe-abz-ok">On a 3-day trial until ${esc(new Date(t.expires_at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}.</p>`
        : `<p class="mut">It already had a licence, so no trial was added.</p>`;
    } else if (lic === 'none') licLine = `<p class="mut" style="margin:10px 0 0">No licence yet: they buy one when they sign in.</p>`;
    else licLine = `<p class="mut" style="margin:10px 0 0">Next, set its licence in the licence portal.</p>`;
    // sign-in: email the invite (new logins only; an existing login keeps its password)
    let signIn = '';
    if (r.existing) {
      signIn = `<p style="margin:10px 0 0">${esc(e)} already had a PROVIEW EMPLOYEE login, so they were made Owner / Admin of this business and keep the password they already use.${invite ? ' No invite was needed.' : ' The password you typed was not applied.'}</p>`;
    } else if (invite) {
      const { error: me } = await O.sb.auth.resetPasswordForEmail(e, { redirectTo: location.origin + location.pathname });
      signIn = me ? `<p class="pe-abz-warn">The business was added, but the invite email couldn’t be sent (${esc(O.friendly(me))}). They can use “Forgot password?” on the sign-in page with ${esc(e)}.</p>`
        : `<p class="pe-abz-ok">Invite sent to <b>${esc(e)}</b>. They open the email link and choose their own password.</p>`;
    }
    A.closeModal();
    ALLB.at = 0; pickList = null; await loadAll(true); render();
    const site = location.origin + location.pathname, details = `PROVIEW EMPLOYEE login\n${site}\nEmail: ${e}\nPassword: ${pw}`;
    const pwCard = !r.existing && !invite ? `<p class="mut" style="margin:10px 0">The owner can sign in now. No email was sent, so pass these on yourself:</p>
        <div class="pe-abz-card"><div><span class="mut">Sign in at</span><b>${esc(site.replace(/^https?:\/\//, ''))}</b></div><div><span class="mut">Email</span><b>${esc(e)}</b></div><div><span class="mut">Password</span><b>${esc(pw)}</b></div></div>
        <button class="btn" type="button" style="margin-top:10px" id="peAbCopy">${ic('copy', 16)} Copy login details</button>` : '';
    openModal(`<div class="pad pe-abz"><div class="row between"><b style="font-size:17px">${esc(biz)} added</b><button class="icon-btn" data-act="closeModal" aria-label="Close">${ic('x')}</button></div>
      ${signIn}${pwCard}${licLine}
      <div class="row" style="justify-content:flex-end;gap:8px;margin-top:16px;flex-wrap:wrap">${lic === 'set' ? `<a class="btn" href="${LIC_PORTAL}" target="_blank" rel="noopener">Set licence ${ic('link', 14)}</a>` : ''}<button class="btn" data-act="closeModal">Stay here</button><button class="btn pri" data-act="peAllOpen" data-id="${esc(r.org_id)}" data-loc="${esc(r.location_id || '')}">Open business</button></div></div>`, 520);
    const c = $('#peAbCopy'); if (c) c.onclick = () => abCopy(details);
  };
  // on the All sites home there's no business open: only the All sites page, and no business tools
  const _renderNow = renderNow;
  renderNow = function () {
    const home = !!(O.ready && O.home);
    if (home) U.view = 'allbiz';
    document.body.classList.toggle('pe-home', home);
    try { syncSite(); } catch (e) {}
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
  const SHORT = { getstarted: 'Start', dashboard: 'Home', timesheets: 'Timesheets', rota: 'Rota', tasks: 'Tasks', live: 'Locations', timeoff: 'Time off', reports: 'Reports', invoices: 'Invoices', ai: 'AI', people: 'People', payslips: 'Payslips', tracking: 'Tracking', schedules: 'Schedules', timeoffset: 'Leave', locations: 'Locations', projects: 'Projects', organization: 'Company',
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
  /* ---------------- master: "All sites" first in the left menu; on All sites every page is greyed out
     until a site is picked (ALLSITES_MENU_STANDARD, the same in all Proview apps) ---------------- */
  const allMode = () => !!(O.ready && O.master && (O.home || U.view === 'allbiz'));
  const _renderNav4 = renderNav;
  renderNav = function () {
    _renderNav4.apply(this, arguments);
    const nv = document.querySelector('.side .nav'); if (!nv) return;
    nv.querySelector('.pe-all-nav')?.remove();
    document.body.classList.toggle('pe-allmode', allMode());
    if (!O.ready || !O.master) return;
    const on = allMode();
    nv.insertAdjacentHTML('afterbegin', `<button class="pe-all-nav${on ? ' on' : ''}" data-act="peAllSites" title="Locations"${on ? ' aria-current="page"' : ''}>${ic('pvloc', 19)}<span class="lbl">Locations</span><span class="slbl">Locations</span></button>`);
    if (!on) return;
    nv.querySelectorAll(':scope > button:not(.pe-all-nav)').forEach((b) => {
      const name = b.querySelector('.lbl')?.textContent || b.title || '';
      b.classList.remove('on'); b.classList.add('pe-off');
      b.setAttribute('aria-disabled', 'true'); b.dataset.act = 'peNeedSite';
      b.title = name + ' – choose a location first';
    });
  };
  // any other toast goes back to the app's usual place
  const _toastPE = toast;
  toast = function () { document.getElementById('toast')?.classList.remove('pe-toast-bottom'); return _toastPE.apply(this, arguments); };
  A.peAllSites = () => { if (U.view === 'allbiz' || O.home) { U.view = 'allbiz'; render(); return; } A.pePickOrg({ value: '__all' }); };
  A.peNeedSite = () => {
    toast('Choose a location in the dropdown first', 'bad');
    document.getElementById('toast')?.classList.add('pe-toast-bottom');   // phones: not over the drop-down it points at
    const s = document.querySelector('#top .hdr-pick select'); if (!s) return;
    const w = s.closest('.hdr-pick');
    s.focus({ preventScroll: true });
    w.classList.remove('pe-pulse'); void w.offsetWidth; w.classList.add('pe-pulse');
    setTimeout(() => w.classList.remove('pe-pulse'), 1100);
  };
  const css5 = document.createElement('style');
  css5.textContent = `.side .nav button.pe-off{opacity:.45;cursor:not-allowed}
.side .nav button.pe-off:hover,.side .nav button.pe-off:focus{background:transparent!important;color:inherit!important}
.side .nav .pe-all-nav svg{flex:none}
@media (max-width:700px){#toast.pe-toast-bottom{top:auto!important;bottom:calc(16px + env(safe-area-inset-bottom,0px))!important}}
.top .hdr-pick.pe-pulse select{animation:pePickPulse 1s ease-out}
@keyframes pePickPulse{0%{box-shadow:0 0 0 0 rgba(90,141,238,.75)}30%{box-shadow:0 0 0 5px rgba(90,141,238,.45)}100%{box-shadow:0 0 0 0 rgba(90,141,238,0)}}`;
  document.head.appendChild(css5);
  const css3 = document.createElement('style');
  css3.textContent = `.slbl{display:none}
@media (min-width:701px) and (max-width:900px){.side .nav button{flex-direction:column;gap:4px!important;padding:8px 2px 7px!important;justify-content:center}.side .slbl{display:block;font-size:10.5px;line-height:1.15;font-weight:500;text-align:center;white-space:nowrap;letter-spacing:-.1px}.side .nav button .cnt{display:none}.side-foot button{flex-direction:column;gap:3px;padding:7px 2px!important}.side-foot .slbl{font-size:10px}.side-foot button[data-act=collapse]{display:none!important}}
/* site picker: in the top header right after the page title, on every screen size (same as Proview WiFi;
   Bookings and Label use the same .hdr-pick markup and rules) */
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.top .hdr-pick { margin: 0 0 0 6px; flex: 0 1 auto; min-width: 0; }
.top .hdr-pick select { display: block; width: auto; height: 38px; max-width: 320px; min-width: 170px; border-radius: 10px; border: 1px solid var(--line); background-color: #fff; color: var(--ink); font: 600 14px var(--font); padding: 0 30px 0 12px; cursor: pointer; text-overflow: ellipsis; white-space: nowrap; overflow: hidden; }
.top .hdr-pick select:focus { outline: none; border-color: var(--line); }
.top .hdr-pick select:focus-visible { outline: 2px solid #5a8dee; outline-offset: 2px; }
.top .hdr-pick select:disabled { opacity: 1; cursor: default; color: var(--ink); appearance: none; -webkit-appearance: none; padding-right: 12px; }
/* phones: the tray leaves no room on the title row, so the picker gets the header's second row, full width */
@media (max-width: 700px) {
  .top { flex-wrap: wrap; row-gap: 6px; }
  .top .hdr-pick { order: 1; flex: 1 0 100%; margin: 0; }
  .top .hdr-pick select { width: 100%; min-width: 0; max-width: none; height: 36px; font-size: 13px; }
}
/* (end of Signage's block) Employee only: its font variable, and its phone header's nowrap title row */
:root { --font: "Inter", "Segoe UI", system-ui, -apple-system, Roboto, Helvetica, Arial, sans-serif; }
.top > h2 { flex: 0 0 auto; white-space: nowrap; }
body.dark .top .hdr-pick select { background-color: var(--card); }
/* Employee makes every phone-width box 16px; keep Signage's 13px except on touch screens (where both apps use 16px) */
@media (max-width: 700px) and (pointer: fine), (max-width: 700px) and (hover: hover) { .top .hdr-pick select { font-size: 13px !important; } }
@media (max-width: 700px) { #top.top { flex-wrap: wrap !important; } #top.top > h2 { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; } }`;
  document.head.appendChild(css3);

  const css2 = document.createElement('style');
  css2.textContent = `.lic-banner{display:flex;gap:12px;align-items:center;flex-wrap:wrap;border:1px solid #f3d38a;background:#fff8e6;color:#7a5200;margin-bottom:16px}.lic-banner>svg{flex:none;align-self:flex-start;margin-top:2px}.lic-banner .lic-txt{flex:1;min-width:200px}.lic-banner .lic-btn{flex:none;margin-left:auto;text-decoration:none}.lic-banner.ok{border-color:var(--line);background:var(--card);color:var(--ink)}@media (max-width:700px){.lic-banner .lic-btn{width:100%;justify-content:center;margin-left:0;min-height:40px}}.lic-banner.bad{border-color:#f3c7c3;background:#fdf0ef;color:#a02219}.lic-banner a{color:inherit;font-weight:700}`;
  document.head.appendChild(css2);
  const css4 = document.createElement('style');
  css4.textContent = `body.pe-home #tabbar,body.pe-home .clockbox,body.pe-home .side-foot [data-act=kiosk],body.pe-home .top>span[style*="width:1px"]{display:none!important}body.pe-home #venueCard{pointer-events:none}`;
  document.head.appendChild(css4);
})();
