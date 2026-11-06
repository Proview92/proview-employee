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

  /* ---------------- master page ---------------- */
  const M = { data: [], q: '', filter: 'all', loading: false };
  const host = document.createElement('div'); host.id = 'master'; document.body.appendChild(host);
  const css = document.createElement('style');
  css.textContent = `
#master{display:none}
body.master-on #master{display:block;position:fixed;inset:0;z-index:44;overflow:auto;background:var(--bg)}
body.master-on #app,body.master-on #login{visibility:hidden}
.ms-top{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:12px;padding:12px 22px;background:#141418;color:#fff}
.ms-top .wordmark2{font-size:14px}.ms-top .ms-tag{font-size:12px;color:#9a9aa4;border-left:1px solid #33333c;padding-left:12px}
.ms-top .sp{flex:1}.ms-top .btn{background:#23232a;border-color:#33333c;color:#ddd}
.ms-main{max-width:1180px;margin:0 auto;padding:22px;display:flex;flex-direction:column;gap:16px}
.ms-head{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap}
.ms-head h1{margin:0;font-size:26px;letter-spacing:-.015em}
.ms-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.ms-stat{padding:14px 16px}.ms-stat b{display:block;font-size:22px;margin-top:2px}
.ms-card .ms-ch{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line)}
.ms-card .ms-ch h2{font-size:16px;margin:0;flex:1}
.ms-row{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line)}
.ms-row:last-child{border-bottom:0}.ms-row .grow{flex:1;min-width:0}
.ms-row .nm{font-weight:650}.ms-row .tiny{font-size:12.5px;color:var(--mut);margin-top:2px;overflow:hidden;text-overflow:ellipsis}
.ms-acts{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.ms-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ms-tools .inp{height:34px;width:220px}.ms-tools select.inp{width:auto;padding:0 28px 0 10px;line-height:32px}
.ms-empty{padding:30px 16px;text-align:center;color:var(--mut)}
.ms-prev{background:var(--bg);border-radius:10px;padding:10px 12px;font-size:13.5px;margin-top:12px}
.ms-staff-av{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:11.5px;font-weight:700;flex:none;background:#4a6cd0}
@media (max-width:760px){
 .ms-top{padding:10px 14px}.ms-top .ms-tag{display:none}.ms-main{padding:14px;gap:12px}
 .ms-row{flex-wrap:wrap}.ms-acts{width:100%;justify-content:flex-start}
 .ms-tools{width:100%}.ms-tools .inp{flex:1;width:auto}
 .ms-head h1{font-size:22px}
}`;
  document.head.appendChild(css);

  async function load() {
    M.loading = true; paint();
    const { data, error } = await O.sb.rpc('pe_master_overview');
    M.loading = false;
    if (error) { toast(O.friendly(error), 'bad'); return paint(); }
    M.data = data || []; paint();
  }
  const allStaff = () => M.data.flatMap((o) => o.staff.filter((s) => !s.archived).map((s) => ({ ...s, org: o })));
  function initials(n) { return String(n || '?').split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase(); }

  function paint() {
    if (!document.body.classList.contains('master-on')) return;
    const staff = allStaff();
    const paid = staff.filter((s) => licOk(s) && s.license_type !== 'trial3').length;
    const trial = staff.filter((s) => s.license_type === 'trial3' && licOk(s)).length;
    const locked = staff.filter((s) => !licOk(s)).length;
    const needs = staff.map((s) => ({ s, L: licState(s) })).filter(({ L }) => ['none', 'expiring', 'grace', 'expired'].includes(L.state))
      .sort((a, b) => (a.L.expires ?? 0) - (b.L.expires ?? 0));
    const q = M.q.trim().toLowerCase();
    const match = (s) => !q || [s.name, s.email, s.org.name].some((x) => (x || '').toLowerCase().includes(q));
    const fil = (s) => M.filter === 'all' || (M.filter === 'paid' && licOk(s) && s.license_type !== 'trial3') || (M.filter === 'trial' && s.license_type === 'trial3' && licOk(s)) || (M.filter === 'locked' && !licOk(s));
    const mine = (O.orgs || []).filter((o) => !o.locked);
    host.innerHTML = `
<div class="ms-top"><span class="logo auth2-mark" style="width:30px!important;height:22px!important"></span><span class="wordmark2"><b>PROVIEW</b><span>EMPLOYEE</span></span><span class="ms-tag">Master admin</span><span class="sp"></span>
${mine.length ? `<button class="btn sm" data-act="msOpenMine">${ic('building', 15)} ${mine.length === 1 ? 'Open ' + esc(mine[0].org_name) : 'My companies'}</button>` : ''}
<button class="btn sm" data-act="signOut" title="Sign out">${ic('logout', 15)}<span class="hide-sm">Sign out</span></button></div>
<div class="ms-main">
 <div class="ms-head"><div><h1>Businesses and licences</h1><p class="mut" style="margin:4px 0 0">${plural(M.data.length, 'business')} · ${plural(staff.length, 'staff member')} · ${paid} paid · ${trial} on trial · ${locked} without access</p></div>
 <div class="row" style="gap:8px"><a class="btn" href="https://license.proviewcrm.co.uk" target="_blank" rel="noopener">Licence portal ↗</a><button class="btn" data-act="msReload">${ic('swap', 15)} Refresh</button><button class="btn pri" data-act="msNewOrg">${ic('plus', 15)} New business</button></div></div>
 ${M.loading && !M.data.length ? `<div class="card ms-empty">Loading…</div>` : ''}
 ${needs.length ? `<div class="card ms-card"><div class="ms-ch"><h2>Licences needing attention</h2><span class="chip amber">${needs.length}</span></div>
   ${needs.slice(0, 50).map(({ s }) => `<div class="ms-row"><div class="ms-staff-av">${esc(initials(s.name))}</div><div class="grow"><div class="nm">${esc(s.name || 'Unnamed')}</div><div class="tiny">${esc(s.org.name)} · ${esc(s.role)}${s.email ? ' · ' + esc(s.email) : ''}</div></div>${licBadge(s)}<div class="ms-acts"><a class="btn sm pri" href="https://license.proviewcrm.co.uk" target="_blank" rel="noopener">Renew ↗</a></div></div>`).join('')}
   ${needs.length > 50 ? `<div class="ms-row mut small">and ${needs.length - 50} more, see All staff below</div>` : ''}</div>` : ''}
 <div class="card ms-card"><div class="ms-ch"><h2>Businesses</h2></div>
  ${M.data.length ? M.data.map((o) => {
    const st = o.staff.filter((s) => !s.archived), ok = st.filter(licOk).length, logins = st.filter((s) => s.has_login).length;
    return `<div class="ms-row"><div class="grow"><div class="nm">${esc(o.name)} ${o.suspended ? '<span class="chip red">On hold</span>' : ''} ${o.self_signup ? '<span class="chip">Signed up online</span>' : ''}</div>
      <div class="tiny">${[o.contact_email, plural(st.length, 'staff member'), plural(logins, 'sign-in'), 'since ' + fmt(o.created_at), o.last_active ? 'last active ' + fmt(o.last_active) : null, o.notes ? o.notes.slice(0, 60) : null].filter(Boolean).map(esc).join(' · ')}</div></div>
      <span class="chip ${ok === st.length && st.length ? 'green' : ok ? 'amber' : 'red'}">${ok}/${st.length} licensed</span>
      <div class="ms-acts"><button class="btn sm pri" data-act="msOpenOrg" data-o="${esc(o.id)}" title="Open this business with full access">Open</button><button class="btn sm" data-act="msOrgStaff" data-o="${esc(o.id)}">Licences</button><button class="btn sm ghost" data-act="msEditOrg" data-o="${esc(o.id)}" title="Edit" aria-label="Edit ${esc(o.name)}">${ic('edit', 15)}</button></div></div>`;
  }).join('') : (M.loading ? '' : `<div class="ms-empty"><b>No businesses yet</b><br>Add one, or they appear here when a customer signs up online.<br><br><button class="btn pri" data-act="msNewOrg">${ic('plus', 15)} New business</button></div>`)}</div>
 <div class="card ms-card"><div class="ms-ch"><h2>All staff</h2><div class="ms-tools"><input class="inp" id="msQ" placeholder="Search name, email or business" value="${esc(M.q)}" autocomplete="off">
   <select class="inp" style="width:auto" data-act-change="msFilter">${[['all', 'Everyone'], ['paid', 'Paid'], ['trial', 'On trial'], ['locked', 'Without access']].map(([k, l]) => `<option value="${k}" ${M.filter === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
  ${(() => { const list = staff.filter((s) => match(s) && fil(s)); return list.length ? list.map((s) => `<div class="ms-row"><div class="ms-staff-av">${esc(initials(s.name))}</div><div class="grow"><div class="nm">${esc(s.name || 'Unnamed')}</div><div class="tiny">${[s.org.name, s.role, s.email, s.has_login ? 'can sign in' : 'no sign-in yet'].filter(Boolean).map(esc).join(' · ')}</div></div>${licBadge(s)}<div class="ms-acts"><a class="btn sm" href="https://license.proviewcrm.co.uk" target="_blank" rel="noopener">Licence ↗</a></div></div>`).join('') : `<div class="ms-empty">No staff match.</div>`; })()}</div>
</div>`;
    if (M.focusQ) { const i = $('#msQ'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } M.focusQ = false; }
  }

  function open() {
    document.body.classList.add('master-on');
    O.lsSet('pe-master-mode:' + O.user.id, true);
    paint(); load();
  }
  window.PE_MASTER = { open, reload: load };

  A.msReload = () => load();
  host.addEventListener('input', (e) => { if (e.target.id === 'msQ') { M.q = e.target.value; M.focusQ = true; paint(); } });
  A.msFilter = (el) => { M.filter = el.value; paint(); };
  A.msOpenMine = () => {
    const mine = (O.orgs || []).filter((o) => !o.locked);
    const go = (org) => { A.closeModal(); O.lsSet('pe-master-mode:' + O.user.id, false); document.body.classList.remove('master-on'); O.enterOrg(org); };
    if (mine.length === 1) return go(mine[0]);
    A.msGo = (el) => go(mine.find((o) => o.org_id === el.dataset.o));
    openModal(`<div class="pad"><div class="row between"><b style="font-size:17px">Open a company</b><button class="icon-btn" data-act="closeModal">${ic('x')}</button></div>${mine.map((o) => `<button class="btn" style="width:100%;justify-content:flex-start;margin-top:10px" data-act="msGo" data-o="${esc(o.org_id)}">${ic('building', 15)} ${esc(o.org_name)} <span class="mut small" style="margin-left:auto">${esc(o.role)}</span></button>`).join('')}</div>`, 420);
  };
  // open any business as the Proview master admin (Owner rights, not one of their staff)
  A.msOpenOrg = (el) => {
    const o = M.data.find((x) => x.id === el.dataset.o); if (!o) return;
    const mine = (O.orgs || []).find((x) => x.org_id === o.id && !x.locked);
    O.lsSet('pe-master-mode:' + O.user.id, false);
    document.body.classList.remove('master-on'); host.innerHTML = '';
    O.enterOrg(mine || { org_id: o.id, org_name: o.name, member_id: 'proview-master', role: 'Owner', as_master: true });
  };
  A.msBackToMaster = () => { O.lsSet('pe-master-mode:' + O.user.id, true); location.reload(); };

  const findStaff = (o, m) => { const org = M.data.find((x) => x.id === o); return { org, s: org?.staff.find((x) => x.member_id === m) }; };

  /* licences are managed in the Proview licence portal; this view is read-only */
  const LIC_PORTAL = 'https://license.proviewcrm.co.uk';
  A.msLic = () => window.open(LIC_PORTAL, '_blank', 'noopener');
  A.msOrgStaff = (el) => {
    const org = M.data.find((x) => x.id === el.dataset.o); if (!org) return;
    const st = org.staff.filter((s) => !s.archived);
    openModal(`<div class="pad"><div class="row between"><b style="font-size:17px">${esc(org.name)}: licences</b><button class="icon-btn" data-act="closeModal">${ic('x')}</button></div>
      <div style="margin:10px -24px 0;border-top:1px solid var(--line)">${st.map((s) => `<div class="ms-row"><div class="grow"><div class="nm">${esc(s.name || 'Unnamed')}</div><div class="tiny">${esc(s.role)}${s.email ? ' · ' + esc(s.email) : ''}</div></div>${licBadge(s)}</div>`).join('') || '<div class="ms-empty">No staff yet.</div>'}</div>
      <div style="border-top:1px solid var(--line);margin:0 -24px;padding:14px 24px 0" class="row between"><span class="small mut">Licences are set and renewed in the licence portal.</span><a class="btn pri" href="${LIC_PORTAL}" target="_blank" rel="noopener">Open licence portal ↗</a></div></div>`, 560);
  };
  A.signOut = async function () { document.body.classList.remove('master-on'); host.innerHTML = ''; return _signOut.apply(this, arguments); };

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
    const buyBtn = O.asMaster ? '' : `<button class="btn sm pri" data-act="peBuy" style="margin-left:auto;flex:none">Buy / renew online</button>`;
    if (!soon.length && !gone.length) return O.asMaster ? html : `<div class="card pad lic-banner" role="status" style="align-items:center">${ic('shield', 18)}<div class="small">${plural(people.length, 'staff licence')} active.</div>${buyBtn}</div>` + html;
    const names = (l) => l.slice(0, 4).map((m) => esc(m.name.split(' ')[0])).join(', ') + (l.length > 4 ? ` and ${l.length - 4} more` : '');
    return `<div class="card pad lic-banner ${gone.length ? 'bad' : ''}" role="status">${ic('shield', 18)}<div><b>${gone.length ? `${plural(gone.length, 'person')} can’t clock in` : `${plural(soon.length, 'licence')} ending soon`}</b><div class="small">${gone.length ? `Licence ended for ${names(gone)}. ` : ''}${soon.length ? `Ending soon: ${names(soon)}. ` : ''}Buy or renew online, or contact Proview: <a href="mailto:altun@proviewtech.co.uk">altun@proviewtech.co.uk</a></div></div>${buyBtn}</div>` + html;
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

  // master admins inside one of their own companies: a way back to the master page
  const _renderTop = renderTop;
  renderTop = function () {
    _renderTop.apply(this, arguments);
    if (!O.ready || !O.master) return;
    const top = $('#top'); if (!top || top.querySelector('[data-act=msBackToMaster]')) return;
    const b = document.createElement('button'); b.className = 'btn sm'; b.dataset.act = 'msBackToMaster'; b.innerHTML = ic('shield', 14) + '<span class="hide-sm"> Master admin</span>'; b.title = 'Master admin';
    const sp = top.querySelector('.sp'); if (sp) sp.after(b); else top.appendChild(b);
  };

  /* ---------------- business picker under the logo (same as Proview Signage's client picker) ---------------- */
  // Master admins see every business (plus a way back to the master page); others see the companies they belong to.
  let pickList = null, pickLoading = false;
  async function pickLoad() {
    if (pickLoading) return; pickLoading = true;
    try { const { data } = await O.sb.rpc('pe_master_overview'); pickList = (data || []).map((o) => ({ id: o.id, name: o.name })); if (!M.data.length) M.data = data || []; }
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
    return `<select aria-label="Business" title="Switch business" data-act-change="pePickOrg">${O.master ? `<option value="__master">Master admin: all businesses</option>` : ''}${items.map((o) => `<option value="${esc(o.id)}" ${o.id === O.org ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>`;
  }
  A.pePickOrg = (el) => {
    const id = el.value; if (!id || id === O.org) return;
    if (id === '__master') return A.msBackToMaster();
    const mine = (O.orgs || []).find((x) => x.org_id === id && !x.locked);
    const o = (pickList || []).find((x) => x.id === id);
    O.enterOrg(mine || { org_id: id, org_name: o?.name || '', member_id: 'proview-master', role: 'Owner', as_master: true });
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
  const css3 = document.createElement('style');
  css3.textContent = `.client-pick{margin:0 14px 12px}.client-pick:empty{display:none}
.client-pick select,.top-pick select{width:100%;background:#23232a;color:#fff;border:1px solid #33333c;border-radius:9px;padding:9px 30px 9px 11px;font:inherit;font-size:14px;font-weight:500;appearance:none;-webkit-appearance:none;cursor:pointer;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23fff' stroke-width='1.8' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 11px center;text-overflow:ellipsis}
.client-pick select:hover{border-color:#4a4a55}.client-pick select:focus-visible,.top-pick select:focus-visible{outline:2px solid var(--pri);outline-offset:1px}
.client-pick select option{background:#23232a;color:#fff}
.client-pick .sp-title{color:#9a9aa4;font-size:13px;padding:0 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.app.collapsed .client-pick{display:none}.top-pick{display:none}
@media (min-width:701px) and (max-width:900px){.client-pick{display:none}}
@media (max-width:900px){.top-pick{display:block;max-width:46%;min-width:0;margin:0 6px}.top-pick select{padding:7px 28px 7px 10px;font-size:15px;background-color:var(--card);color:var(--ink);border:1px solid var(--line);background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23888' stroke-width='1.8' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")}.top-pick select option{background:var(--card);color:var(--ink)}}
@media (max-width:700px){.top:has(.top-pick){flex-wrap:wrap!important;row-gap:8px!important;height:auto}.top .top-pick{order:20;flex:1 0 100%;max-width:none;margin:0 0 2px}}
@media (hover:none) and (pointer:coarse){.client-pick select,.top-pick select{font-size:16px}}`;
  document.head.appendChild(css3);

  const css2 = document.createElement('style');
  css2.textContent = `.lic-banner{display:flex;gap:12px;align-items:flex-start;border:1px solid #f3d38a;background:#fff8e6;color:#7a5200;margin-bottom:14px}.lic-banner.bad{border-color:#f3c7c3;background:#fdf0ef;color:#a02219}.lic-banner a{color:inherit;font-weight:700}`;
  document.head.appendChild(css2);
})();
