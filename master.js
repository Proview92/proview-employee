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

  /* ---------------- master admin (Proview): MASTER_OPEN_SPEC ----------------
     No view of every business here. "Open in Employee" in the licence portal signs the master in with a biz claim;
     sso-login answers { open: <pe_orgs id> } (cloud.js keeps it per tab in sessionStorage pv_master_open), and the
     master opens exactly that business as its Owner. Without one: "Open a business from the licence portal". */
  const LIC_PORTAL = 'https://license.proviewcrm.co.uk';
  async function open() {
    O.masterMissing = false;
    const id = O.masterOpenId && O.masterOpenId();
    if (!id) { O.openHome(); return; }
    let org = null;
    try { const { data, error } = await O.sb.from('pe_orgs').select('id,name').eq('id', id).maybeSingle(); if (error) throw error; org = data; }
    catch (e) { org = null; }
    if (!org) { O.masterMissing = true; O.openHome(); return; }
    O.masterOrgName = org.name;
    await O.enterOrg({ org_id: org.id, org_name: org.name, member_id: 'proview-master', role: 'Owner', as_master: true });
  }
  window.PE_MASTER = { open };
  TITLES.masterhome = 'Proview Employee';
  VIEWS.masterhome = function () {
    const t = O.masterMissing ? 'That business couldn’t be found here. It may have been deleted, or linked into another business. Open the business again from the licence portal.'
      : 'As Proview you open a business’s Employee from its page in the licence portal (Open in Employee). It opens here, inside that business.';
    return `<div class="card pad pv-master-home"><h2 style="margin:0 0 8px;font-size:20px">Open a business from the licence portal</h2><p class="mut" style="margin:0 0 14px">${t}</p><a class="btn pri" href="${LIC_PORTAL}">Go to license.proviewcrm.co.uk</a></div>`;
  };
  // "Viewing <Business> as Proview" under the header while the master is inside a location's business
  function masterBar() {
    let b = document.getElementById('pvMasterBar');
    const on = !!(O.ready && O.master && O.asMaster && O.org && !O.home);
    if (!on) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('div'); b.id = 'pvMasterBar'; b.className = 'pv-master-bar'; b.setAttribute('role', 'status'); }
    const top = document.getElementById('top'); if (top && b.previousElementSibling !== top) top.after(b);
    b.innerHTML = `<span>Viewing <b>${esc((S.org && S.org.name) || O.orgName || O.masterOrgName || 'this business')}</b> as Proview</span><a class="pv-master-back" href="${LIC_PORTAL}">Back to licence portal</a>`;
  }

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
        soonLoc.length ? `Business licence ending soon: ${names(soonLoc)}. ` : '',
        soonAdd.length ? `Staff add-on ending soon: ${names(soonAdd)}. ` : ''].join('');
      banner = `<div class="card pad lic-banner ${bad ? 'bad' : lines ? '' : 'ok'}" role="status">${ic('shield', 18)}<div class="lic-txt"><b>${esc(pkg)}</b><span class="small"> · ${plural(locs.filter((l) => locOk(l)).length, 'business licence')} (10 staff each)${need.length ? ` · ${plural(need.length, 'person')} need${need.length === 1 ? 's' : ''} a staff add-on` : ''}</span>${lines ? `<div class="small">${lines}${O.asMaster ? '' : 'Buy online, or contact Proview: <a href="mailto:altun@proviewtech.co.uk">altun@proviewtech.co.uk</a>'}</div>` : ''}</div>${buyBtn}</div>`;
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
      body = `<p class="small mut" style="margin:6px 0 10px">Each business needs its own licence, which includes up to 10 staff (the earliest joined). Anyone over that needs a staff add-on. You’ll pay securely with Stripe; time is added on top of any current licence and it updates within about 5 minutes.</p>
      <div class="row between" style="margin-top:6px"><b>Business licences</b><span class="tiny">${esc(`${st.included} of ${st.allowance} staff included`)}</span></div>
      ${hasLoc ? `<label class="f">Business licence plan</label>${planSel('peBuyLocPlan', locPlans)}` : '<p class="small mut">Online payment for business licences isn’t available yet: call 020 8935 5495.</p>'}
      <div style="margin:8px -24px 0;border-top:1px solid var(--line)">${locs.map((l) => row(l.name, 'Business licence · includes 10 staff', licBadge(l), 'peBuyLoc', `data-l="${esc(l.id)}"`, hasLoc && licState(l).state !== 'lifetime')).join('') || '<div class="ms-empty" style="padding:10px 24px">No locations yet.</div>'}</div>
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

  /* ---------------- business drop-down in the top header (MULTI_BUSINESS_PICKER_STANDARD, owner update 07:47) ----------------
     Business names only, by name: someone in several usable businesses picks one and it opens as a whole (all its
     locations). One business, and the master inside the business opened from the licence portal: its name, disabled.
     Pages that need one location have their own location select (the dashboard filter, Organization → This location). */
  const byName = (a, b) => String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase());
  // the sites (locations) this person may see in the open business
  function mySites() {
    const L = (S.locations || []).filter((l) => !l.archived).slice().sort(byName);
    if (O.asMaster || ['Owner', 'Admin'].includes(O.role)) return L;
    const m = typeof me === 'function' ? me() : null;
    const only = m && Array.isArray(m.sites) && m.sites.length ? m.sites : null;
    return only ? L.filter((l) => only.includes(l.id)) : L;
  }
  O.mySites = mySites;
  // [{ id, name }]: the businesses to list (usable ones: O.usableOrgs, from cloud.js), the open one always included
  function pickBiz() {
    const curName = (S.org && S.org.name) || O.orgName || 'This business';
    if (O.master || !O.orgs) return O.org ? [{ id: O.org, name: curName }] : [];
    const ok = O.usableOrgs || (O.orgs || []).filter((o) => !o.locked).map((o) => o.org_id);
    const g = (O.orgs || []).filter((o) => ok.includes(o.org_id) || o.org_id === O.org)
      .map((o) => ({ id: o.org_id, name: o.org_id === O.org ? (o.org_name || curName) : o.org_name }));
    if (O.org && !g.some((o) => o.id === O.org)) g.push({ id: O.org, name: curName });
    return g.filter((o, i) => g.findIndex((x) => x.id === o.id) === i).sort(byName);
  }
  function pickHtml() {
    if (!O.ready || !O.org) return '';
    const list = pickBiz();
    const wrap = (sel) => `<div class="hdr-pick"><label class="sr" for="hdr-biz">Business</label>${sel}</div>`;
    if (list.length <= 1) { const t = list[0]?.name || ''; return wrap(`<select id="hdr-biz" aria-label="Business" title="${esc(t)}" disabled><option>${esc(t)}</option></select>`); }
    const cur = list.find((o) => o.id === O.org);
    return wrap(`<select id="hdr-biz" aria-label="Business" title="${esc(cur?.name || '')}" data-act-change="pePickOrg">${list.map((o) => `<option value="${esc(o.id)}"${o.id === O.org ? ' selected' : ''}>${esc(o.name)}</option>`).join('')}</select>`);
  }
  // another business opened: the dashboard's own location filter starts again at "All locations"
  let siteOrg = null;
  function syncSite() {
    if (!O.ready || !O.org || O.home) { siteOrg = null; return; }
    if (O.org !== siteOrg) { if (siteOrg !== null) U.fLoc = ''; siteOrg = O.org; if (U.fLoc && !mySites().some((x) => x.id === U.fLoc)) U.fLoc = ''; }
  }
  A.pePickOrg = (el) => {
    const id = el.value;
    if (!id || id === O.org || O.master) return;   // the master stays in the business they opened
    const mine = (O.orgs || []).find((x) => x.org_id === id && !x.locked);
    if (mine) O.enterOrg(mine);
  };
  /* ---------------- Organization → "This location" (MULTI_BUSINESS_PICKER_STANDARD: no Locations page) ----------------
     The Locations page is gone. What it edited (name, address, coordinates, geofence radius) and the location's licence
     are here, for one location: a location select at the top of the section when the business has more than one
     (remembered per business on this device), none with one location. Owners and admins save; others see it read-only. */
  const locKey = () => (O.user && O.org ? `pe-setloc:${O.user.id}:${O.org}` : '');
  function thisLocId() {
    const L = mySites(); if (!L.length) return '';
    let id = U.setLoc && L.some((l) => l.id === U.setLoc) ? U.setLoc : '';
    if (!id) { try { id = JSON.parse(localStorage.getItem(locKey()) || '""') || ''; } catch (e) { id = ''; } }
    if (!L.some((l) => l.id === id)) id = L[0].id;
    U.setLoc = id; return id;
  }
  function thisLocationHtml() {
    const L = mySites();
    if (!L.length) return `<div class="card pad pe-this-loc" style="margin-top:14px;max-width:1100px"><b style="font-size:15px">This location</b><p class="small mut" style="margin:6px 0 0">No location yet. Businesses are set up by Proview.</p></div>`;
    const id = thisLocId(), l = locn(id) || L[0];
    const can = O.asMaster || isAdminRole();
    const dis = can ? '' : ' disabled';
    const pick = L.length > 1 ? `<label class="f" for="peThisLoc" style="margin-top:8px">Location</label><select class="inp" id="peThisLoc" aria-label="Location" data-act-change="peThisLocPick" style="max-width:320px">${L.map((x) => `<option value="${esc(x.id)}"${x.id === l.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : '';
    const st = LS(), lic = st && (st.locations || []).find((x) => x.id === l.id);
    const licRow = lic ? `<div class="setrow pe-this-lic"><div><b>Business licence</b><div class="d">Each business needs its own licence, which includes up to 10 staff.</div></div><div class="row" style="gap:8px">${licBadge(lic)}${O.asMaster ? `<a class="btn sm" href="${LIC_PORTAL}" target="_blank" rel="noopener">Licence portal ↗</a>` : isAdminRole() && licState(lic).state !== 'lifetime' ? `<button class="btn sm pri" data-act="peBuy">${['none', 'expired'].includes(licState(lic).state) ? 'Buy licence online' : 'Renew online'}</button>` : ''}</div></div>` : '';
    const r = +l.radius || 300;
    return `<div class="card pad pe-this-loc" style="margin-top:14px;max-width:1100px"><b style="font-size:15px">This location</b>${pick}
     <div class="grid2" style="margin-top:6px"><div>${fld('Location name', `<input class="inp" id="peLocName" value="${esc(l.name || '')}"${dis}>`)}</div><div>${fld('Address', `<input class="inp" id="peLocAddr" value="${esc(l.address || '')}"${dis}>`)}</div></div>
     <div class="grid2"><div>${fld('Coordinates', `<div class="grid2"><input class="inp" id="peLocLat" type="number" step="0.00001" value="${esc(l.lat ?? '')}" placeholder="Latitude"${dis}><input class="inp" id="peLocLng" type="number" step="0.00001" value="${esc(l.lng ?? '')}" placeholder="Longitude"${dis}></div>`)}</div><div>${fld('Geofence radius (metres)', `<input class="inp" id="peLocRad" type="number" min="50" step="10" value="${r}"${dis}>`)}</div></div>
     <div class="small mut" style="margin-top:4px">Used for geofencing and the live map. To assign locations as geofences, <a href="#" data-act="go" data-v="schedules">go to Work Schedules</a>.</div>
     ${licRow}
     ${can ? `<div class="row" style="margin-top:12px;gap:8px"><button class="btn sm" data-act="peLocHere">${ic('target', 14)} Use my current location</button><button class="btn sm pri" data-act="peLocSave">Save location</button></div>` : '<p class="small mut" style="margin:10px 0 0">Only owners and admins can change these.</p>'}</div>`;
  }
  A.peThisLocPick = (el) => { U.setLoc = el.value; try { localStorage.setItem(locKey(), JSON.stringify(el.value)); } catch (e) {} render(); };
  A.peLocHere = () => {
    if (!navigator.geolocation) return toast('Location not supported here');
    navigator.geolocation.getCurrentPosition((p) => { const a = $('#peLocLat'), b = $('#peLocLng'); if (a) a.value = (+p.coords.latitude).toFixed(5); if (b) b.value = (+p.coords.longitude).toFixed(5); }, () => toast('Couldn’t get your location', 'bad'));
  };
  A.peLocSave = () => {
    if (!(O.asMaster || isAdminRole())) return;
    const l = locn(thisLocId()); if (!l) return;
    const name = ($('#peLocName')?.value || '').trim(), lat = +$('#peLocLat')?.value, lng = +$('#peLocLng')?.value, rad = Math.max(50, +$('#peLocRad')?.value || 300);
    if (!name) return toast('Name the location', 'bad');
    if (isNaN(lat) || isNaN(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return toast('Check the coordinates', 'bad');
    Object.assign(l, { name, address: ($('#peLocAddr')?.value || '').trim(), lat, lng, radius: rad });
    S.setup.locations = true; save(); render(); toast(`Location ${name} saved`);
  };
  const _org = VIEWS.organization;
  VIEWS.organization = function () {
    const html = _org.apply(this, arguments);
    if (!O.ready || O.home || (U.orgTab && U.orgTab !== 'details')) return html;
    return html + thisLocationHtml();
  };

  // the master with no location opened: only the "Open a business" page, no business tools
  const _renderNow = renderNow;
  renderNow = function () {
    const home = !!(O.ready && O.home);
    if (home) U.view = 'masterhome';
    else if (U.view === 'locations') U.view = O.ready && O.role === 'Member' && !O.asMaster ? 'sHome' : 'dashboard';   // the Locations page is gone
    document.body.classList.toggle('pe-home', home);
    try { syncSite(); } catch (e) {}
    const r = _renderNow.apply(this, arguments);
    try { masterBar(); } catch (e) {}
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
  const SHORT = { getstarted: 'Start', dashboard: 'Home', timesheets: 'Timesheets', rota: 'Rota', tasks: 'Tasks', live: 'Live', timeoff: 'Time off', reports: 'Reports', invoices: 'Invoices', ai: 'AI', people: 'People', payslips: 'Payslips', tracking: 'Tracking', schedules: 'Schedules', timeoffset: 'Leave', projects: 'Projects', organization: 'Company',
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
  // any other toast goes back to the app's usual place
  const _toastPE = toast;
  toast = function () { document.getElementById('toast')?.classList.remove('pe-toast-bottom'); return _toastPE.apply(this, arguments); };
  const css5 = document.createElement('style');
  css5.textContent = `@media (max-width:700px){#toast.pe-toast-bottom{top:auto!important;bottom:calc(16px + env(safe-area-inset-bottom,0px))!important}}
/* the Proview master inside one location's business, opened from the licence portal (MASTER_OPEN_SPEC) */
.pv-master-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:8px 20px;background:#fff7e0;border-bottom:1px solid #f1dfa6;color:#5c4400;font-size:13.5px}
.pv-master-bar b{font-weight:700}.pv-master-bar .pv-master-back{margin-left:auto;color:#5c4400;font-weight:600;text-decoration:underline;text-underline-offset:2px;white-space:nowrap}
body.dark .pv-master-bar{background:#3a2f12;border-color:#5c4a1a;color:#f3dc9b}body.dark .pv-master-bar .pv-master-back{color:#f3dc9b}
.pv-master-home{max-width:560px;margin:8vh auto 0}.pv-master-home a.btn{text-decoration:none}
body.pe-home .side .nav > button,body.pe-home .side .nav .nav-sec,body.pe-home .top .hdr-cap{display:none!important}`;
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
