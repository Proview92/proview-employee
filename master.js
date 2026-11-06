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
 <div class="row" style="gap:8px"><button class="btn" data-act="msReload">${ic('swap', 15)} Refresh</button><button class="btn pri" data-act="msNewOrg">${ic('plus', 15)} New business</button></div></div>
 ${M.loading && !M.data.length ? `<div class="card ms-empty">Loading…</div>` : ''}
 ${needs.length ? `<div class="card ms-card"><div class="ms-ch"><h2>Licences needing attention</h2><span class="chip amber">${needs.length}</span></div>
   ${needs.slice(0, 50).map(({ s }) => `<div class="ms-row"><div class="ms-staff-av">${esc(initials(s.name))}</div><div class="grow"><div class="nm">${esc(s.name || 'Unnamed')}</div><div class="tiny">${esc(s.org.name)} · ${esc(s.role)}${s.email ? ' · ' + esc(s.email) : ''}</div></div>${licBadge(s)}<div class="ms-acts"><button class="btn sm pri" data-act="msLic" data-o="${esc(s.org.id)}" data-m="${esc(s.member_id)}">Renew…</button></div></div>`).join('')}
   ${needs.length > 50 ? `<div class="ms-row mut small">and ${needs.length - 50} more, see All staff below</div>` : ''}</div>` : ''}
 <div class="card ms-card"><div class="ms-ch"><h2>Businesses</h2></div>
  ${M.data.length ? M.data.map((o) => {
    const st = o.staff.filter((s) => !s.archived), ok = st.filter(licOk).length, logins = st.filter((s) => s.has_login).length;
    return `<div class="ms-row"><div class="grow"><div class="nm">${esc(o.name)} ${o.suspended ? '<span class="chip red">On hold</span>' : ''} ${o.self_signup ? '<span class="chip">Signed up online</span>' : ''}</div>
      <div class="tiny">${[o.contact_email, plural(st.length, 'staff member'), plural(logins, 'sign-in'), 'since ' + fmt(o.created_at), o.last_active ? 'last active ' + fmt(o.last_active) : null, o.notes ? o.notes.slice(0, 60) : null].filter(Boolean).map(esc).join(' · ')}</div></div>
      <span class="chip ${ok === st.length && st.length ? 'green' : ok ? 'amber' : 'red'}">${ok}/${st.length} licensed</span>
      <div class="ms-acts"><button class="btn sm" data-act="msOrgStaff" data-o="${esc(o.id)}">Licences</button><button class="btn sm ghost" data-act="msEditOrg" data-o="${esc(o.id)}" title="Edit" aria-label="Edit ${esc(o.name)}">${ic('edit', 15)}</button></div></div>`;
  }).join('') : (M.loading ? '' : `<div class="ms-empty"><b>No businesses yet</b><br>Add one, or they appear here when a customer signs up online.<br><br><button class="btn pri" data-act="msNewOrg">${ic('plus', 15)} New business</button></div>`)}</div>
 <div class="card ms-card"><div class="ms-ch"><h2>All staff</h2><div class="ms-tools"><input class="inp" id="msQ" placeholder="Search name, email or business" value="${esc(M.q)}" autocomplete="off">
   <select class="inp" style="width:auto" data-act-change="msFilter">${[['all', 'Everyone'], ['paid', 'Paid'], ['trial', 'On trial'], ['locked', 'Without access']].map(([k, l]) => `<option value="${k}" ${M.filter === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
  ${(() => { const list = staff.filter((s) => match(s) && fil(s)); return list.length ? list.map((s) => `<div class="ms-row"><div class="ms-staff-av">${esc(initials(s.name))}</div><div class="grow"><div class="nm">${esc(s.name || 'Unnamed')}</div><div class="tiny">${[s.org.name, s.role, s.email, s.has_login ? 'can sign in' : 'no sign-in yet'].filter(Boolean).map(esc).join(' · ')}</div></div>${licBadge(s)}<div class="ms-acts"><button class="btn sm" data-act="msLic" data-o="${esc(s.org.id)}" data-m="${esc(s.member_id)}">Licence</button></div></div>`).join('') : `<div class="ms-empty">No staff match.</div>`; })()}</div>
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
  A.msBackToMaster = () => { O.lsSet('pe-master-mode:' + O.user.id, true); location.reload(); };

  const findStaff = (o, m) => { const org = M.data.find((x) => x.id === o); return { org, s: org?.staff.find((x) => x.member_id === m) }; };

  /* licence dialog */
  A.msLic = (el) => {
    const { org, s } = findStaff(el.dataset.o, el.dataset.m); if (!s) return;
    const cur = licState(s), canStack = ['active', 'expiring'].includes(cur.state) && s.license_type !== 'trial3';
    const def = cur.state === 'none' || s.license_type === 'trial3' ? 'm12' : (MONTHS[s.license_type] ? s.license_type : 'm12');
    openModal(`<div class="pad"><div class="row between"><b style="font-size:17px">Licence for ${esc(s.name || 'staff member')}</b><button class="icon-btn" data-act="closeModal">${ic('x')}</button></div>
      <p class="mut small" style="margin:4px 0 10px">${esc(org.name)} · ${esc(s.role)}${s.email ? ' · ' + esc(s.email) : ''}</p>
      <div class="row" style="gap:8px">Now: ${licBadge(s)}</div>${s.license_notes ? `<p class="small mut" style="margin:8px 0 0">Note: ${esc(s.license_notes)}</p>` : ''}
      <label class="f">Licence</label><select class="inp" id="msT" data-act-change="msLicPrev">${LIC_TYPES.map(([k, l]) => `<option value="${k}" ${k === def ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <div id="msCustomW" style="display:none"><label class="f">End date</label><input class="inp" type="date" id="msCustom" data-act-change="msLicPrev"></div>
      ${canStack ? `<label class="row small" style="gap:8px;margin-top:12px;font-weight:600"><input type="checkbox" id="msExt" checked data-act-change="msLicPrev"> Add on top of the current end date (${fmt(cur.expires)})</label>` : ''}
      <label class="f">Note (only you see this)</label><input class="inp" id="msNote" placeholder="Invoice number, payment, contact…" value="">
      <div class="ms-prev" id="msPrev"></div>
      <div class="row" style="justify-content:space-between;margin-top:16px;gap:8px">${s.license_type ? `<button class="btn" style="color:var(--bad)" data-act="msLicRemove" data-o="${esc(org.id)}" data-m="${esc(s.member_id)}">Remove licence</button>` : '<span></span>'}
      <div class="row" style="gap:8px"><button class="btn" data-act="closeModal">Cancel</button><button class="btn pri" data-act="msLicSave" data-o="${esc(org.id)}" data-m="${esc(s.member_id)}">Save licence</button></div></div></div>`, 460);
    M.cur = s; A.msLicPrev();
  };
  A.msLicPrev = () => {
    const t = $('#msT')?.value; if (!t) return;
    $('#msCustomW').style.display = t === 'custom' ? '' : 'none';
    const end = previewEnd(t, { extend: $('#msExt')?.checked, current: M.cur?.expires_at, custom: $('#msCustom')?.value });
    $('#msPrev').innerHTML = end === null ? 'Never ends.' : end === undefined ? 'Choose an end date.' : `Access until <b>${fmt(end)}</b>${t === 'trial3' ? ' (no grace period after a trial)' : `, then ${LIC_GRACE_DAYS} days’ grace`}.`;
  };
  A.msLicSave = async (el) => {
    const t = $('#msT').value, custom = $('#msCustom').value;
    if (t === 'custom' && !custom) return toast('Choose an end date', 'bad');
    const { error } = await O.sb.rpc('pe_set_license', { o: el.dataset.o, m: el.dataset.m, t, extend: !!$('#msExt')?.checked,
      custom_end: t === 'custom' ? new Date(custom + 'T23:59:00').toISOString() : null, note: $('#msNote').value || null });
    if (error) return toast(O.friendly(error), 'bad');
    A.closeModal(); toast('Licence saved'); load();
  };
  A.msLicRemove = (el) => ask('Remove this licence? The person loses access straight away.', async () => {
    const { error } = await O.sb.rpc('pe_remove_license', { o: el.dataset.o, m: el.dataset.m });
    if (error) return toast(O.friendly(error), 'bad');
    A.closeModal(); toast('Licence removed'); load();
  }, 'Remove');

  /* one business: its staff and their licences, with "licence everyone" */
  A.msOrgStaff = (el) => {
    const org = M.data.find((x) => x.id === el.dataset.o); if (!org) return;
    const st = org.staff.filter((s) => !s.archived);
    openModal(`<div class="pad"><div class="row between"><b style="font-size:17px">${esc(org.name)}: licences</b><button class="icon-btn" data-act="closeModal">${ic('x')}</button></div>
      <div style="margin:10px -24px 0;border-top:1px solid var(--line)">${st.map((s) => `<div class="ms-row"><div class="grow"><div class="nm">${esc(s.name || 'Unnamed')}</div><div class="tiny">${esc(s.role)}${s.email ? ' · ' + esc(s.email) : ''}</div></div>${licBadge(s)}<button class="btn sm" data-act="msLic" data-o="${esc(org.id)}" data-m="${esc(s.member_id)}">Licence</button></div>`).join('') || '<div class="ms-empty">No staff yet.</div>'}</div>
      ${st.length ? `<div style="border-top:1px solid var(--line);margin:0 -24px;padding:14px 24px 0"><b>Licence everyone</b><div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap"><select class="inp" id="msAllT" style="width:auto">${LIC_TYPES.filter(([k]) => k !== 'custom' && k !== 'trial3').map(([k, l]) => `<option value="${k}" ${k === 'm12' ? 'selected' : ''}>${l}</option>`).join('')}</select><label class="row small" style="gap:6px;font-weight:600"><input type="checkbox" id="msAllExt" checked> Add on top of current end dates</label><button class="btn pri" data-act="msLicAll" data-o="${esc(org.id)}">Apply to ${plural(st.length, 'person')}</button></div></div>` : ''}</div>`, 560);
  };
  A.msLicAll = (el) => {
    const org = M.data.find((x) => x.id === el.dataset.o); const st = org.staff.filter((s) => !s.archived);
    const t = $('#msAllT').value, ext = $('#msAllExt').checked;
    ask(`Give ${plural(st.length, 'person')} at ${org.name} a ${licLabel(t).toLowerCase()} licence?`, async () => {
      let bad = 0;
      for (const s of st) { const { error } = await O.sb.rpc('pe_set_license', { o: org.id, m: s.member_id, t, extend: ext, custom_end: null, note: null }); if (error) bad++; }
      A.closeModal(); toast(bad ? `${st.length - bad} saved, ${bad} failed` : 'Licences saved', bad ? 'bad' : undefined); load();
    }, 'Apply');
  };

  /* new / edit business */
  A.msNewOrg = () => openModal(`<div class="pad"><div class="row between"><b style="font-size:17px">New business</b><button class="icon-btn" data-act="closeModal">${ic('x')}</button></div>
    <p class="mut small" style="margin:4px 0 0">The owner gets a 3-day trial. They sign up at employee.proviewcrm.co.uk with this email and go straight into their business.</p>
    <label class="f">Business name</label><input class="inp" id="msN" placeholder="Bella Pizza">
    <label class="f">Owner’s name</label><input class="inp" id="msON" placeholder="Bella Rossi">
    <label class="f">Owner’s email</label><input class="inp" type="email" id="msOE" placeholder="owner@business.co.uk">
    <label class="f">Notes (only you see these)</label><input class="inp" id="msNt" placeholder="Contract, contact, price…">
    <div class="row" style="justify-content:flex-end;gap:8px;margin-top:16px"><button class="btn" data-act="closeModal">Cancel</button><button class="btn pri" data-act="msNewOrgSave">Create business</button></div></div>`, 440);
  A.msNewOrgSave = async () => {
    const company = $('#msN').value.trim(), owner_name = $('#msON').value.trim(), owner_email = $('#msOE').value.trim().toLowerCase();
    if (!company) return toast('Enter the business name', 'bad');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(owner_email)) return toast('Enter the owner’s email address', 'bad');
    const { error } = await O.sb.rpc('pe_master_create_org', { company, owner_name, owner_email, note: $('#msNt').value || null });
    if (error) return toast(O.friendly(error), 'bad');
    A.closeModal(); load();
    const link = location.origin + location.pathname;
    openModal(`<div class="pad"><b style="font-size:17px">${esc(company)} is ready</b><p class="mut" style="margin:8px 0 0">Send this to ${esc(owner_name || owner_email)}:</p>
      <textarea class="inp" id="msMsg" rows="5" style="width:100%;margin-top:10px;height:auto">Hi ${owner_name ? owner_name.split(' ')[0] : 'there'}, your Proview Employee account for ${company} is ready. Go to ${link}, press “Create an account” and use ${owner_email}. You’ll go straight into your business.</textarea>
      <div class="row" style="justify-content:flex-end;gap:8px;margin-top:12px"><button class="btn" data-act="msCopy">${ic('copy', 15)} Copy</button><button class="btn pri" data-act="closeModal">Done</button></div></div>`, 460);
  };
  A.msCopy = async () => { try { await navigator.clipboard.writeText($('#msMsg').value); toast('Copied'); } catch (e) { $('#msMsg').select(); } };
  A.msEditOrg = (el) => {
    const o = M.data.find((x) => x.id === el.dataset.o); if (!o) return;
    openModal(`<div class="pad"><div class="row between"><b style="font-size:17px">Edit business</b><button class="icon-btn" data-act="closeModal">${ic('x')}</button></div>
      <label class="f">Business name</label><input class="inp" id="msEN" value="${esc(o.name)}">
      <label class="f">Contact email</label><input class="inp" type="email" id="msEE" value="${esc(o.contact_email || '')}">
      <label class="f">Notes (only you see these)</label><textarea class="inp" id="msENt" rows="3" style="height:auto">${esc(o.notes || '')}</textarea>
      <label class="row small" style="gap:8px;margin-top:12px;font-weight:600"><input type="checkbox" id="msES" ${o.suspended ? 'checked' : ''}> Put on hold (nobody at this business can sign in)</label>
      <div class="row" style="justify-content:space-between;margin-top:16px;gap:8px"><button class="btn" style="color:var(--bad)" data-act="msDelOrg" data-o="${esc(o.id)}">Delete business</button>
      <div class="row" style="gap:8px"><button class="btn" data-act="closeModal">Cancel</button><button class="btn pri" data-act="msEditOrgSave" data-o="${esc(o.id)}">Save</button></div></div></div>`, 460);
  };
  A.msEditOrgSave = async (el) => {
    const email = $('#msEE').value.trim();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('Enter a valid email address', 'bad');
    const { error } = await O.sb.rpc('pe_master_update_org', { o: el.dataset.o, new_name: $('#msEN').value, email, note: $('#msENt').value, is_suspended: $('#msES').checked });
    if (error) return toast(O.friendly(error), 'bad');
    A.closeModal(); toast('Saved'); load();
  };
  A.msDelOrg = (el) => {
    const o = M.data.find((x) => x.id === el.dataset.o);
    ask(`Delete ${o.name} and everything in it (staff, clock-ins, timesheets, payslips and P45s)? This can’t be undone.`, async () => {
      const { error } = await O.sb.rpc('pe_master_delete_org', { o: o.id });
      if (error) return toast(O.friendly(error), 'bad');
      A.closeModal(); toast(`${o.name} deleted`); load();
    }, 'Delete');
  };

  const _signOut = A.signOut;
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
    if (!soon.length && !gone.length) return html;
    const names = (l) => l.slice(0, 4).map((m) => esc(m.name.split(' ')[0])).join(', ') + (l.length > 4 ? ` and ${l.length - 4} more` : '');
    return `<div class="card pad lic-banner ${gone.length ? 'bad' : ''}" role="status">${ic('shield', 18)}<div><b>${gone.length ? `${plural(gone.length, 'person')} can’t clock in` : `${plural(soon.length, 'licence')} ending soon`}</b><div class="small">${gone.length ? `Licence ended for ${names(gone)}. ` : ''}${soon.length ? `Ending soon: ${names(soon)}. ` : ''}Contact Proview to renew: <a href="mailto:altun@proviewtech.co.uk">altun@proviewtech.co.uk</a></div></div></div>` + html;
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

  const css2 = document.createElement('style');
  css2.textContent = `.lic-banner{display:flex;gap:12px;align-items:flex-start;border:1px solid #f3d38a;background:#fff8e6;color:#7a5200;margin-bottom:14px}.lic-banner.bad{border-color:#f3c7c3;background:#fdf0ef;color:#a02219}.lic-banner a{color:inherit;font-weight:700}`;
  document.head.appendChild(css2);
})();
