/* =====================================================================
   Proview Employee — online accounts and live sync (Supabase)
   Loaded after the main app script. When config.js is present the app
   signs in with real accounts and keeps its data on the server; the
   privacy rules in supabase/schema.sql decide what each person receives.
   ===================================================================== */
(function () {
  'use strict';
  const C = window.PE_CONFIG;
  if (!C || !C.SUPABASE_URL || !C.SUPABASE_KEY) return;

  const O = window.PE_ONLINE = {
    sb: null, user: null, org: null, orgName: '', member: null, role: null, ready: false,
    snap: new Map(),          // key -> canonical JSON of the server copy
    rows: new Map(),          // key -> {coll,id,member_id,data} of the server copy
    queue: new Map(),         // key -> row waiting to be sent ({...row, deleted})
    pushing: false, timer: null, retry: 0, channel: null, booting: true, applying: false,
  };
  const HERE = location.origin + location.pathname;
  const SB_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
  const SECRET_FIELDS = ['rate', 'billRate', 'pin', 'qr', 'face'];
  const DROP_FIELDS = ['pwHash', 'mustChange'];

  /* ---------------- small helpers ---------------- */
  const loadScript = (src) => new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
  const canon = (v) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : canon(x))).join(',') + ']';
    return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const key = (coll, id) => coll + ':' + id;
  const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) {} };
  const cacheKey = () => 'pe-cache:' + O.user?.id + ':' + O.org;
  const queueKey = () => 'pe-queue:' + O.user?.id + ':' + O.org;
  const friendly = (e) => {
    const m = String(e?.message || e || '');
    if (/Invalid login credentials/i.test(m)) return 'That email or password isn’t right. Try again.';
    if (/Email not confirmed/i.test(m)) return 'Please confirm your email first — click the link we sent you.';
    if (/User already registered/i.test(m)) return 'There’s already an account with that email. Sign in instead.';
    if (/rate limit|too many/i.test(m)) return 'Too many emails sent just now. Please wait a few minutes and try again.';
    if (/Password should be/i.test(m)) return 'Use at least 8 characters for your password.';
    if (/Failed to fetch|NetworkError|network/i.test(m)) return 'Can’t reach the server. Check your internet connection.';
    return m || 'Something went wrong. Please try again.';
  };

  /* ---------------- which records live where ---------------- */
  // [coll, get array from S, set array on S, member field]
  const ARRAYS = [
    ['groups', (s) => s.groups, (s, v) => (s.groups = v), null],
    ['activities', (s) => s.activities, (s, v) => (s.activities = v), null],
    ['projects', (s) => s.projects, (s, v) => (s.projects = v), null],
    ['clients', (s) => s.clients, (s, v) => (s.clients = v), null],
    ['locations', (s) => s.locations, (s, v) => (s.locations = v), null],
    ['schedules', (s) => s.schedules, (s, v) => (s.schedules = v), null],
    ['policies', (s) => s.timeoff.policies, (s, v) => (s.timeoff.policies = v), null],
    ['calendars', (s) => s.timeoff.calendars, (s, v) => (s.timeoff.calendars = v), null],
    ['needs', (s) => s.rota.needs, (s, v) => (s.rota.needs = v), null],
    ['taskTemplates', (s) => s.taskTemplates, (s, v) => (s.taskTemplates = v), null],
    ['entries', (s) => s.entries, (s, v) => (s.entries = v), 'member'],
    ['requests', (s) => s.timeoff.requests, (s, v) => (s.timeoff.requests = v), 'member'],
    ['shifts', (s) => s.rota.shifts, (s, v) => (s.rota.shifts = v), 'member'],
    ['tasks', (s) => s.tasks, (s, v) => (s.tasks = v), 'assignee'],
    ['docs', (s) => s.docs, (s, v) => (s.docs = v), 'member'],
    ['notes', (s) => s.notes, (s, v) => (s.notes = v), null],
    ['audit', (s) => s.audit, (s, v) => (s.audit = v), null],
    ['exports', (s) => s.exports, (s, v) => (s.exports = v), 'by'],
    ['invoices', (s) => s.invoices, (s, v) => (s.invoices = v), null],
    ['chat', (s) => s.chat, (s, v) => (s.chat = v), 'by'],
  ];
  const OBJECTS = [
    ['org', (s) => s.org, (s, v) => (s.org = v)],
    ['settings', (s) => { const x = { ...s.settings }; delete x.dark; return x; }, (s, v) => { const dark = s.settings?.dark; s.settings = { ...v, dark }; }],
    ['setup', (s) => s.setup, (s, v) => (s.setup = v)],
    ['rotaSettings', (s) => s.rota.settings, (s, v) => (s.rota.settings = v)],
  ];
  const SHARED = new Set(['org', 'settings', 'setup', 'groups', 'activities', 'projects', 'clients', 'locations', 'schedules', 'policies', 'calendars', 'needs', 'rotaSettings', 'taskTemplates']);

  // Turn the app state into one row per record
  function rowsFromS(s) {
    const out = new Map();
    const add = (coll, id, member_id, data) => { if (id == null || id === '') return; out.set(key(coll, String(id)), { coll, id: String(id), member_id: member_id == null ? null : String(member_id), data }); };
    for (const [coll, get, , mf] of ARRAYS) (get(s) || []).forEach((x) => add(coll, x.id, mf ? (x[mf] ?? '') : null, x));
    for (const [coll, get] of OBJECTS) { const v = get(s); if (v) add(coll, coll, null, v); }
    (s.members || []).forEach((m) => {
      if (m._virtual) return;
      const pub = { ...m }, sec = {};
      SECRET_FIELDS.forEach((f) => { if (f in pub) { sec[f] = pub[f]; delete pub[f]; } });
      DROP_FIELDS.forEach((f) => delete pub[f]);
      add('members', m.id, m.id, pub);
      if (Object.keys(sec).length) add('secrets', m.id, m.id, sec);
    });
    Object.entries(s.approvals || {}).forEach(([k, v]) => add('approvals', k, k.split('|')[0], v));
    if (!O.asMaster) (s.ai || []).forEach((a) => add('ai', a.r + ':' + a.at, O.member, a));
    return out;
  }

  // Build the app state from the rows I'm allowed to see
  function stateFromRows(rows) {
    const s = defaults();
    s.timeoff.calendars = [];
    s.rota = { shifts: [], needs: [], settings: { maxDays: 5, minRest: 11, avoidOT: true, fairWeekends: true }, seedPending: false };
    s.tasks = []; s.taskTemplates = []; s.tasksSeedPending = false;
    s.docs = []; s.audit = []; s.docsSeeded = true; s.payslipsSeeded = true; s.demoTagged = true;
    const by = {};
    rows.forEach((r) => { (by[r.coll] = by[r.coll] || []).push(r); });
    for (const [coll, , set] of ARRAYS) set(s, (by[coll] || []).map((r) => clone(r.data)));
    for (const [coll, , set] of OBJECTS) { const r = (by[coll] || [])[0]; if (r) set(s, clone(r.data)); }
    const secrets = new Map((by.secrets || []).map((r) => [r.id, r.data]));
    s.members = (by.members || []).map((r) => ({ ...clone(r.data), ...clone(secrets.get(r.id) || {}) }));
    s.approvals = {}; (by.approvals || []).forEach((r) => (s.approvals[r.id] = clone(r.data)));
    s.ai = (by.ai || []).map((r) => clone(r.data)).sort((a, b) => a.at - b.at);
    s.entries.sort((a, b) => a.in - b.in);
    s.notes.sort((a, b) => b.at - a.at);
    s.me = O.member;
    if (!s.settings) s.settings = defaults().settings;
    s.settings.dark = !!lsGet('pe-dark');
    return s;
  }
  function finishState(s) {
    s = upgrade(s);
    s.me = O.member;
    s.rota.seedPending = false; s.tasksSeedPending = false;
    const cal = (s.timeoff.calendars || []).find((c) => c.isDefault) || s.timeoff.calendars?.[0];
    if (cal) { cal.holidays = cal.holidays || []; s.timeoff.holidays = cal.holidays; }
    return s;
  }

  /* ---------------- what may I send? (the server checks again) ---------------- */
  function managedIds() {
    if (O.role !== 'Manager') return new Set();
    const gs = new Set(S.groups.filter((g) => g.manager === O.member).map((g) => g.id));
    return new Set(S.members.filter((m) => gs.has(m.group) && !['Owner', 'Admin'].includes(m.role)).map((m) => m.id));
  }
  function mayWrite(row, team) {
    const admin = O.role === 'Owner' || O.role === 'Admin', mgr = O.role === 'Manager';
    const c = row.coll, m = row.member_id;
    if (SHARED.has(c)) return admin || (mgr && ['needs', 'rotaSettings', 'taskTemplates'].includes(c));
    if (c === 'notes') return admin || mgr;          // staff leave requests are announced by the server
    if (c === 'audit') return true;
    if (c === 'exports') return admin || m === O.member;
    if (c === 'invoices') return admin;
    if (c === 'ai') return m === O.member;
    if (c === 'chat') return m === O.member;
    if (admin) return true;
    const boss = mgr && m && m !== O.member && team.has(m);
    if (['members', 'secrets', 'approvals'].includes(c)) return boss;
    if (c === 'shifts') return mgr && (!m || boss || m === O.member);
    if (c === 'tasks' && !m) return mgr;
    return boss || m === O.member;
  }

  /* ---------------- sending changes ---------------- */
  function noteChanges() {
    if (!O.ready || O.applying) return;
    const now = rowsFromS(S), team = managedIds();
    now.forEach((r, k) => {
      const c = canon(r.data);
      if (O.snap.get(k) === c && O.rows.get(k)?.member_id === r.member_id) { O.queue.delete(k); return; }
      if (!mayWrite(r, team)) return;
      O.queue.set(k, { ...r, data: clone(r.data), deleted: false });
    });
    O.rows.forEach((r, k) => {
      if (now.has(k)) return;
      if (!mayWrite(r, team)) return;
      O.queue.set(k, { ...r, deleted: true });
    });
    lsSet(queueKey(), [...O.queue.values()]);
    schedulePush(400);
  }
  function schedulePush(ms) { clearTimeout(O.timer); O.timer = setTimeout(push, ms); }

  async function push() {
    if (O.pushing || !O.queue.size || !O.sb || !O.org) return;
    if (!navigator.onLine) { setSync('offline'); return; }
    O.pushing = true; setSync('saving');
    const batch = [...O.queue.values()].slice(0, 200);
    let ok = false;
    const addOnly = (r) => ['notes', 'audit', 'chat'].includes(r.coll) && !r.deleted && !O.rows.has(key(r.coll, r.id));
    const adds = batch.filter(addOnly), ups = batch.filter((r) => !addOnly(r));
    const toBody = (list) => list.map((r) => ({ org_id: O.org, coll: r.coll, id: r.id, member_id: r.member_id, data: r.data, deleted: !!r.deleted }));
    try {
      if (adds.length) {
        const { error } = await O.sb.from('pe_rows').insert(toBody(adds));
        if (!error || error.code === '23505') adds.forEach(done);
        else if (isRefusal(error)) await pushOneByOne(adds);
        else throw error;
      }
      if (ups.length) {
        const { error } = await O.sb.from('pe_rows').upsert(toBody(ups), { onConflict: 'org_id,coll,id' });
        if (!error) ups.forEach(done);
        else if (isRefusal(error)) await pushOneByOne(ups);
        else throw error;
      }
      ok = true;
    } catch (e) {
      console.warn('[sync] will retry', e);
      O.retry = Math.min(O.retry + 1, 6); setSync(navigator.onLine ? 'error' : 'offline');
      O.pushing = false; schedulePush(1000 * 2 ** O.retry); return;
    }
    O.retry = 0; O.pushing = false;
    lsSet(queueKey(), [...O.queue.values()]);
    if (ok) saveCache();
    if (O.queue.size) schedulePush(50); else setSync('synced');
  }
  const isRefusal = (e) => ['42501', 'P0001', '23502', '23503', '22P02'].includes(e?.code) || /row-level security|violates/i.test(e?.message || '');
  function done(r) {
    const k = key(r.coll, r.id), q = O.queue.get(k);
    if (q && canon(q.data) === canon(r.data) && !!q.deleted === !!r.deleted) O.queue.delete(k);
    if (r.deleted) { O.rows.delete(k); O.snap.delete(k); }
    else { O.rows.set(k, { coll: r.coll, id: r.id, member_id: r.member_id, data: clone(r.data) }); O.snap.set(k, canon(r.data)); }
  }
  async function pushOneByOne(batch) {
    const refused = [];
    for (const r of batch) {
      const row = { org_id: O.org, coll: r.coll, id: r.id, member_id: r.member_id, data: r.data, deleted: !!r.deleted };
      const add = ['notes', 'audit', 'chat'].includes(r.coll) && !r.deleted && !O.rows.has(key(r.coll, r.id));
      const { error } = add ? await O.sb.from('pe_rows').insert(row) : await O.sb.from('pe_rows').upsert(row, { onConflict: 'org_id,coll,id' });
      if (!error || (add && error.code === '23505')) { done(r); continue; }
      if (!isRefusal(error)) throw error;
      O.queue.delete(key(r.coll, r.id)); refused.push({ r, error });
    }
    if (refused.length) {
      // put back the server copy of anything that was refused
      const msg = refused.some((x) => x.r.coll === 'chat') ? 'Team chat isn’t switched on for this business yet.' : refused.map((x) => x.error.message).find((m) => m && !/row-level security/i.test(m));
      toast(msg || 'You don’t have permission to change that, so it was put back.', 'bad');
      await reloadRows(refused.map((x) => x.r));
    }
  }
  async function reloadRows(list) {
    for (const r of list) {
      const { data } = await O.sb.from('pe_rows').select('coll,id,member_id,data,deleted').eq('org_id', O.org).eq('coll', r.coll).eq('id', r.id).maybeSingle();
      applyRow(data || { ...r, deleted: true }, true);
    }
    rerender();
  }

  /* ---------------- receiving changes ---------------- */
  function applyRow(row, force) {
    const k = key(row.coll, row.id);
    if (!force && O.queue.has(k)) return false;          // my unsent change wins until it's sent
    const before = O.snap.get(k);
    if (row.deleted) { if (!O.rows.has(k) && !force) return false; O.rows.delete(k); O.snap.delete(k); }
    else {
      const c = canon(row.data);
      if (before === c && !force) return false;
      O.rows.set(k, { coll: row.coll, id: row.id, member_id: row.member_id, data: clone(row.data) }); O.snap.set(k, c);
    }
    O.applying = true;
    try { applyToS(row); } finally { O.applying = false; }
    return true;
  }
  function applyToS(row) {
    const { coll, id } = row, del = !!row.deleted, d = row.data ? clone(row.data) : null;
    const arr = ARRAYS.find((a) => a[0] === coll);
    if (arr) {
      const list = arr[1](S) || []; const i = list.findIndex((x) => String(x.id) === id);
      if (del) { if (i >= 0) list.splice(i, 1); }
      else if (i >= 0) list[i] = d; else list.push(d);
      arr[2](S, list);
      if (coll === 'entries') S.entries.sort((a, b) => a.in - b.in);
      if (coll === 'calendars') { const cal = S.timeoff.calendars.find((c) => c.isDefault) || S.timeoff.calendars[0]; if (cal) S.timeoff.holidays = cal.holidays = cal.holidays || []; }
      return;
    }
    const obj = OBJECTS.find((o) => o[0] === coll);
    if (obj) { if (!del) obj[2](S, d); return; }
    if (coll === 'members' || coll === 'secrets') {
      const i = S.members.findIndex((m) => m.id === id);
      if (coll === 'members') {
        if (del) { if (i >= 0) S.members.splice(i, 1); return; }
        const sec = O.rows.get(key('secrets', id))?.data || {};
        const m = { ...d, ...clone(sec) };
        if (i >= 0) S.members[i] = m; else S.members.push(m);
        if (id === O.member && m.role && m.role !== O.role) { O.role = m.role; }
      } else if (i >= 0) {
        SECRET_FIELDS.forEach((f) => delete S.members[i][f]);
        if (!del) Object.assign(S.members[i], d);
      }
      return;
    }
    if (coll === 'approvals') { if (del) delete S.approvals[id]; else S.approvals[id] = d; return; }
    if (coll === 'ai') { const i = S.ai.findIndex((a) => a.r + ':' + a.at === id); if (del) { if (i >= 0) S.ai.splice(i, 1); } else if (i < 0) S.ai.push(d); }
  }

  let rerenderT = null;
  function rerender() {
    clearTimeout(rerenderT);
    rerenderT = setTimeout(() => {
      const busy = document.querySelector('#drawer.open') || document.querySelector('#modal.show') || (typeof K !== 'undefined' && K) ||
        ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
      if (busy) { rerender(); return; }
      U.keepScroll = true; render();
    }, 250);
  }

  function listen() {
    if (O.channel) O.sb.removeChannel(O.channel);
    O.channel = O.sb.channel('pe-' + O.org)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pe_rows', filter: 'org_id=eq.' + O.org }, (p) => {
        const r = p.new && p.new.coll ? p.new : null; if (!r) return;
        if (applyRow(r)) { saveCache(); rerender(); }
      })
      .subscribe((st) => { if (st === 'SUBSCRIBED') catchUp(); });
  }
  // after a reconnect, fetch anything changed while we were away
  async function catchUp() {
    if (!O.ready || !O.since) return;
    const { data, error } = await O.sb.from('pe_rows').select('coll,id,member_id,data,deleted,updated_at').eq('org_id', O.org).gt('updated_at', O.since).order('updated_at').limit(1000);
    if (error || !data) return;
    let any = false; data.forEach((r) => { any = applyRow(r) || any; O.since = r.updated_at; });
    if (any) { saveCache(); rerender(); }
  }
  addEventListener('online', () => { setSync('saving'); push(); catchUp(); });
  addEventListener('offline', () => setSync('offline'));

  /* ---------------- loading a company ---------------- */
  async function fetchAll() {
    const all = []; let from = 0; const page = 1000;
    for (;;) {
      const { data, error } = await O.sb.from('pe_rows').select('coll,id,member_id,data,updated_at').eq('org_id', O.org).eq('deleted', false).order('coll').order('id').range(from, from + page - 1);
      if (error) throw error;
      all.push(...data);
      if (data.length < page) break;
      from += page;
    }
    return all;
  }
  function saveCache() {
    if (!O.ready) return;
    lsSet(cacheKey(), { since: O.since, org: O.org, orgName: O.orgName, member: O.member, role: O.role, rows: [...O.rows.values()] });
  }
  async function openOrg(org) {
    O.org = org.org_id; O.orgName = org.org_name; O.member = org.member_id; O.role = org.role; O.asMaster = !!org.as_master;
    lsSet('pe-last-org:' + O.user.id, O.org);
    let rows;
    try {
      rows = await fetchAll();
      O.since = rows.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), '1970-01-01');
    } catch (e) {
      const c = lsGet(cacheKey());
      if (!c) throw e;
      rows = c.rows; O.since = c.since; toast('You’re offline — showing your last saved copy', 'bad');
    }
    O.rows = new Map(); O.snap = new Map();
    rows.forEach((r) => { const k = key(r.coll, r.id); O.rows.set(k, { coll: r.coll, id: r.id, member_id: r.member_id, data: r.data }); O.snap.set(k, canon(r.data)); });
    O.queue = new Map(); (lsGet(queueKey()) || []).forEach((r) => O.queue.set(key(r.coll, r.id), r));
    O.applying = true;
    try {
      S = finishState(stateFromRows([...O.rows.values()]));
      // re-apply changes I made offline that haven't been sent yet
      O.queue.forEach((r) => applyToS(r));
    } finally { O.applying = false; }
    // the Proview master admin opens businesses as a screen-only Owner (never saved to their staff list)
    if (O.asMaster && !S.members.some((m) => m.id === O.member)) S.members.push({ id: O.member, name: 'Proview (master admin)', role: 'Owner', email: O.user.email, group: '', archived: false, color: '#5a5fbb', _virtual: true });
    else if (!S.members.some((m) => m.id === O.member)) S.members.push({ id: O.member, name: O.user.user_metadata?.name || O.user.email, role: O.role, email: O.user.email, group: '', archived: false, color: '#4a6cd0' });
    if (!S.org.name || S.org.name === 'Proview Tech') S.org.name = O.orgName || S.org.name;
    O.ready = true;
    rememberEmails();
    try { localStorage.setItem(SESSION_KEY, O.member); } catch (e) {}
    saveCache();
    noteChanges();          // sends anything the upgrade step filled in that I'm allowed to write
    listen();
    setSync(O.queue.size ? 'saving' : 'synced');
  }

  /* ---------------- sign-in flow ---------------- */
  async function afterSignIn(user) {
    O.user = user;
    if (!user.user_metadata?.pwSet && user.app_metadata?.provider === 'email' && user.user_metadata?.invited) setTimeout(() => A.forcePw(), 600);
    setLoading('Opening your company…');
    let orgs;
    try {
      const { data, error } = await O.sb.rpc('pe_whoami'); if (error) throw error; orgs = data || [];
    } catch (e) {
      const c = lsGet('pe-last-org:' + user.id) && lsGet('pe-cache:' + user.id + ':' + lsGet('pe-last-org:' + user.id));
      if (c) orgs = [{ org_id: c.org, org_name: c.orgName, member_id: c.member, role: c.role }];
      else { setLoading(''); LG.err = friendly(e); renderLogin(); return; }
    }
    O.orgs = orgs;
    O.master = orgs.some((o) => o.is_master);
    if (!O.master) { try { const { data } = await O.sb.rpc('pe_am_master'); O.master = !!data; } catch (e) {} }
    const usable = orgs.filter((o) => !o.locked);
    // master admin (Proview): open the last business used (any business, not just their own); no master page
    if (O.master && window.PE_MASTER) {
      const lastOrg = lsGet('pe-last-org:' + user.id);
      if (!usable.length || (lastOrg && !usable.some((o) => o.org_id === lastOrg))) { await window.PE_MASTER.open(); return; }
    }
    if (!orgs.length) {
      const meta = user.user_metadata || {};
      if (meta.company) { await createCompany(meta.name || user.email, meta.company); return; }
      setLoading(''); showNoCompany(); return;
    }
    if (!usable.length) { setLoading(''); showLocked(orgs[0]); return; }
    const last = lsGet('pe-last-org:' + user.id);
    await enterOrg(usable.find((o) => o.org_id === last) || usable[0]);
  }
  async function enterOrg(org) {
    setLoading('Opening your company…');
    try { await openOrg(org); }
    catch (e) { setLoading(''); LG.err = friendly(e); renderLogin(); return; }
    O.myLicence = { type: org.license_type, expires: org.license_expires_at };
    loadLicences().catch(() => {});
    setLoading('');
    LG = { id: '', show: false, err: '', keep: true };
    U.view = O.role === 'Member' ? 'sHome' : (U.view && U.view !== 'sHome' && U.view !== 'master' ? U.view : 'dashboard');
    render();
  }
  O.enterOrg = enterOrg;
  O.lsSet = lsSet; O.lsGet = lsGet; O.friendly = friendly;
  // licences of everyone in my company (owners/admins see all, others see their own)
  async function loadLicences() {
    O.licences = new Map();
    const { data, error } = await O.sb.from('pe_licences').select('member_id,license_type,expires_at,starts_at').eq('org_id', O.org);
    if (error) throw error;
    (data || []).forEach((l) => O.licences.set(l.member_id, { type: l.license_type, expires: l.expires_at }));
    if (O.ready) render();
  }
  O.loadLicences = loadLicences;
  function showLocked(org) {
    const own = org.role === 'Owner' || org.role === 'Admin';
    const why = org.suspended
      ? `<b>${esc(org.org_name)}</b>’s Proview Employee account is on hold.`
      : `Your Proview Employee licence at <b>${esc(org.org_name)}</b> has ended${org.license_expires_at ? ' (' + new Date(org.license_expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) + ')' : ''}.`;
    const what = own ? 'To carry on, contact Proview to renew: <a href="mailto:altun@proviewtech.co.uk">altun@proviewtech.co.uk</a>.' : 'Ask your manager to renew it. Your clock-ins, timesheets and documents are kept safe in the meantime.';
    openModal(`<div class="pad"><b style="font-size:17px">${org.suspended ? 'Account on hold' : 'Licence ended'}</b><p class="mut" style="margin:8px 0 0">${why} ${what}</p><div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn" data-act="signOut">Sign out</button></div></div>`, 440);
  }

  // A new company, with me as the owner. Optionally brings the company already in this browser.
  async function createCompany(name, company) {
    // a new company always starts empty, with only the person who created it
    const local = null, useLocal = false;
    setLoading('Setting up your company…');
    const email = O.user.email.toLowerCase();
    let s, myId;
    if (useLocal) {
      s = clone(local);
      const mine = s.members.find((m) => (m.email || '').toLowerCase() === email);
      myId = mine ? mine.id : 'm' + uid();
      if (mine) { mine.role = 'Owner'; mine.archived = false; }
      else s.members.push({ id: myId, name, role: 'Owner', group: s.groups[0]?.id || '', schedule: (s.schedules.find((x) => x.isDefault) || s.schedules[0])?.id || '', rate: 0, billRate: 0, email, phone: '', pin: String(1000 + Math.floor(Math.random() * 9000)), color: COLORS[0], archived: false, joined: today(), qr: uid() + uid() });
      s.members.forEach((m) => DROP_FIELDS.forEach((f) => delete m[f]));
      s.org.name = company;
    } else {
      myId = 'm' + uid();
      s = starterCompany(name, company, email, myId);
    }
    const { data: org, error } = await O.sb.rpc('pe_create_org', { company, my_member_id: myId });
    if (error) { setLoading(''); LG.err = friendly(error); renderLogin(); return; }
    O.org = org; O.orgName = company; O.member = myId; O.role = 'Owner';
    // upload files (payslips/P45s) and strip them from the records
    if (useLocal && s.docs?.length) {
      for (const d of s.docs) {
        if (d.data && /^data:/.test(d.data)) {
          try { d.path = await uploadDataUrl(d.member, d.id, d.data, d.name); } catch (e) { console.warn('file upload failed', e); }
        }
        delete d.data;
      }
    }
    s.me = myId;
    const rows = rowsFromS(s);
    const body = [...rows.values()].map((r) => ({ org_id: org, coll: r.coll, id: r.id, member_id: r.member_id, data: r.data, deleted: false }));
    // the owner's own member record must exist before the "who manages whom" rules can work
    body.sort((a, b) => (a.coll === 'members' ? -1 : b.coll === 'members' ? 1 : 0));
    for (let i = 0; i < body.length; i += 300) {
      const { error: e2 } = await O.sb.from('pe_rows').upsert(body.slice(i, i + 300), { onConflict: 'org_id,coll,id' });
      if (e2) { setLoading(''); toast(friendly(e2), 'bad'); break; }
    }
    // people moved in from this browser are NOT emailed automatically: invite them from their profile
    const others = useLocal ? s.members.filter((m) => m.id !== myId && m.email && !m.archived).length : 0;
    await O.sb.auth.updateUser({ data: { company: null, pwSet: true } }).catch(() => {});
    await openOrg({ org_id: org, org_name: company, member_id: myId, role: 'Owner' });
    setLoading('');
    U.view = useLocal ? 'dashboard' : 'getstarted';
    render();
    toast(`Welcome, ${String(name).split(' ')[0]} — your company is ready`);
    if (others) setTimeout(() => toast(`To let your ${others} people sign in, open each one in People and press “Send sign-in invite”.`), 2500);
  }
  function starterCompany(name, company, email, myId) {
    const n = defaults(); n.org.name = company; n.org.email = email; n.org.address = '';
    n.groups = [{ id: 'g1', name: 'Team', manager: myId }];
    n.schedules = [{ id: 'sc1', name: 'Standard week', type: 'fixed', days: { 1: ['09:00', '17:30'], 2: ['09:00', '17:30'], 3: ['09:00', '17:30'], 4: ['09:00', '17:30'], 5: ['09:00', '17:30'] }, flexHours: 8, breakMins: 30, dailyOT: 9, weeklyOT: 40, isDefault: true }];
    n.activities = [{ id: 'a1', name: 'Work', color: '#4a6cd0', billable: true }, { id: 'a2', name: 'Admin', color: '#8b8b95', billable: false }];
    n.timeoff.policies = [{ id: 'tp1', name: 'Annual leave', color: '#4a6cd0', paid: true, allowance: 28 }, { id: 'tp2', name: 'Sick leave', color: '#d92d20', paid: true, allowance: 10 }, { id: 'tp3', name: 'Unpaid leave', color: '#8b8b95', paid: false, allowance: 0 }];
    n.timeoff.holidays = UK_HOLIDAYS.map(([date, nm]) => ({ id: uid(), date, name: nm }));
    n.rota = { shifts: [], needs: [], settings: { maxDays: 5, minRest: 11, avoidOT: true, fairWeekends: true }, seedPending: false };
    n.tasks = []; n.taskTemplates = []; n.tasksSeedPending = false; n.docs = []; n.audit = [];
    n.docsSeeded = true; n.payslipsSeeded = true; n.demoTagged = true;
    n.members = [{ id: myId, name, role: 'Owner', group: 'g1', schedule: 'sc1', rate: 0, billRate: 0, email, phone: '', pin: String(1000 + Math.floor(Math.random() * 9000)), color: COLORS[0], archived: false, joined: today(), qr: uid() + uid() }];
    n.me = myId;
    const s = upgrade(n); s.rota.seedPending = false; s.tasksSeedPending = false;
    return s;
  }

  /* ---------------- invites ---------------- */
  async function inviteMembers(list, announce = true) {
    if (!O.ready && !O.org) return;
    let sent = 0, failed = '';
    for (const m of list) {
      const email = String(m.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) continue;
      const role = ['Owner', 'Admin', 'Manager', 'Member'].includes(m.role) ? m.role : 'Member';
      const inv = { org_id: O.org, email, member_id: m.id, role, invited_by: O.user.id };
      const admin = O.role === 'Owner' || O.role === 'Admin';
      const { error } = admin
        ? await O.sb.from('pe_invites').upsert(inv, { onConflict: 'org_id,member_id' })
        : await O.sb.from('pe_invites').insert({ ...inv, role: 'Member' });
      if (error && error.code !== '23505') { failed = friendly(error); continue; }
      const r = await O.sb.auth.signInWithOtp({ email, options: { emailRedirectTo: HERE, shouldCreateUser: true, data: { invited: true, name: m.name } } });
      if (r.error) { failed = friendly(r.error); continue; }
      O.invited.add(m.id); sent++;
    }
    if (announce) {
      if (sent) toast(sent === 1 ? `Sign-in invite sent to ${list.find((m) => O.invited.has(m.id))?.email}` : `${sent} sign-in invites sent`);
      if (failed) toast(`Invite not sent: ${failed}`, 'bad');
    }
  }
  O.invited = new Set();
  async function loadInviteState() {
    if (!['Owner', 'Admin', 'Manager'].includes(O.role)) return;
    const [p, i] = await Promise.all([O.sb.from('pe_people').select('member_id').eq('org_id', O.org), O.sb.from('pe_invites').select('member_id').eq('org_id', O.org)]);
    O.linked = new Set((p.data || []).map((x) => x.member_id));
    (i.data || []).forEach((x) => O.invited.add(x.member_id));
  }
  // invite anyone newly given an email who can't sign in yet
  // emails already known when the company was opened are not invited automatically
  const knownEmail = new Map();
  function rememberEmails() { S.members.forEach((m) => knownEmail.set(m.id, (m.email || '').toLowerCase())); }
  async function inviteNew() {
    if (!O.ready || !['Owner', 'Admin', 'Manager'].includes(O.role)) return;
    if (!O.linked) await loadInviteState();
    const list = S.members.filter((m) => !m.archived && m.email && m.id !== O.member && !O.linked.has(m.id) && !O.invited.has(m.id)
      && knownEmail.get(m.id) !== m.email.toLowerCase());
    list.forEach((m) => knownEmail.set(m.id, m.email.toLowerCase()));
    if (list.length) { noteChanges(); await push(); await inviteMembers(list); }
  }
  A.peInvite = async (el) => {
    const m = mem(el?.dataset?.id); if (!m || m.placeholder) return;
    if (!m.email) return toast('Add an email address for them first', 'bad');
    noteChanges(); await push(); O.invited.delete(m.id); await inviteMembers([m]);
    if (document.querySelector('#drawer.open') && D?.kind === 'profile' && D.id === m.id) paintSignIn(m.id);
  };
  // sign-in status on a person's profile (admins and managers)
  function paintSignIn(id) {
    const host = document.querySelector('#drawer .pe-signin') || (() => {
      const first = document.querySelector('#drawer .prof-sec');
      const d = document.createElement('div'); d.className = 'pe-signin';
      if (first) first.parentNode.insertBefore(d, first); else document.querySelector('#drawer')?.appendChild(d);
      return d;
    })();
    const m = mem(id); if (!m) return;
    const linked = O.linked?.has(id), invited = O.invited.has(id), self = id === O.member;
    const status = self ? 'This is you' : linked ? 'Can sign in' : invited ? 'Invite sent — waiting for them to open it' : m.email ? 'Not invited yet' : 'Add an email address to invite them';
    const btn = self || !m.email ? '' : `<button class="btn sm${linked ? '' : ' pri'}" data-act="peInvite" data-id="${esc(id)}">${linked ? 'Send sign-in link again' : invited ? 'Resend invite' : 'Send sign-in invite'}</button>`;
    host.innerHTML = `<div class="row between" style="gap:10px;padding:12px 14px;margin:14px 0;border:1px solid var(--line);border-radius:12px;flex-wrap:wrap"><div><b style="font-size:13px">Sign-in</b><div class="mut small">${status}</div></div>${btn}</div>`;
  }
  const _profileDrawer = profileDrawer;
  profileDrawer = function (id) {
    const r = _profileDrawer.apply(this, arguments);
    if (O.ready && ['Owner', 'Admin', 'Manager'].includes(O.role)) {
      paintSignIn(id);
      if (!O.linked) loadInviteState().then(() => { if (D?.kind === 'profile' && D.id === id) paintSignIn(id); }).catch(() => {});
    }
    return r;
  };

  /* ---------------- screens around sign-in ---------------- */
  let loadingMsg = '';
  function setLoading(t) { loadingMsg = t; if (!realUser()) renderLogin(); }
  function showNoCompany() {
    openModal(`<div class="pad"><b style="font-size:17px">You’re not part of a company yet</b><p class="mut" style="margin:8px 0 0">You’re signed in as <b>${esc(O.user.email)}</b>, but no company has added you. Ask your manager to add this email in People — you’ll get an invite. Or create your own company.</p><label class="f">Your name</label><input class="inp" id="ncName" value="${esc(O.user.user_metadata?.name || '')}"><label class="f">Company name</label><input class="inp" id="ncOrg" placeholder="Your business"><div class="row" style="justify-content:space-between;margin-top:16px"><button class="btn" data-act="signOut">Sign out</button><button class="btn pri" data-act="peNewCompany">Create company</button></div></div>`, 440);
  }
  A.peNewCompany = async () => {
    const name = $('#ncName').value.trim(), company = $('#ncOrg').value.trim();
    if (!name || !company) return toast('Fill in your name and company name', 'bad');
    A.closeModal(); await createCompany(name, company);
  };
  function choose(html, no, yes) {
    return new Promise((res) => {
      A.peChooseNo = () => { A.closeModal(); res(false); }; A.peChooseYes = () => { A.closeModal(); res(true); };
      openModal(`<div class="pad">${html}<div class="row" style="justify-content:flex-end;gap:8px;margin-top:18px"><button class="btn" data-act="peChooseNo">${no}</button><button class="btn pri" data-act="peChooseYes">${yes}</button></div></div>`, 440);
    });
  }

  const _renderLogin = renderLogin;
  renderLogin = function () {
    _renderLogin();
    const el = $('#login'); if (!el) return;
    // email only (no phone sign-in)
    const lab = el.querySelector('label.field2'); if (lab && lab.firstChild && /Email or phone/.test(lab.firstChild.textContent)) lab.firstChild.textContent = 'Email';
    const id = el.querySelector('#lgId'); if (id) { id.type = 'email'; id.autocomplete = 'username'; }
    // "Sign in with Proview account" (owners and managers; one login across Proview apps)
    const go = el.querySelector('form button.pri2[type=submit]');
    if (go && LG.mode !== 'signup' && !el.querySelector('.pv-sso')) {
      go.insertAdjacentHTML('afterend', '<div class="pv-or" style="display:flex;align-items:center;gap:10px;color:#6b6b75;font-size:13px"><span style="flex:1;height:1px;background:#e4e2dc"></span>or<span style="flex:1;height:1px;background:#e4e2dc"></span></div><button type="button" class="btn2 pv-sso" data-act="pvAccount">Sign in with Proview account</button>');
    }
    const slot = el.querySelector('form > div:nth-of-type(2)');
    if (slot && LG.ok && !LG.err) slot.innerHTML = `<div class="lg-ok" role="status">${LG.ok}</div>`;
    if (loadingMsg) {
      const f = el.querySelector('form');
      if (f) f.querySelectorAll('input,button').forEach((x) => (x.disabled = true));
      const b = el.querySelector('button.pri2'); if (b) b.textContent = loadingMsg;
    }
  };

  const PV_ACCOUNT = 'https://license.proviewcrm.co.uk/account/';
  A.pvAccount = () => { location.href = PV_ACCOUNT + '?app=employee&return=' + encodeURIComponent(HERE + location.search); };
  // Arrived from the Proview account page with a signed hand-off: swap it for a normal session.
  async function pvSso(token) {
    const r = await fetch(C.SUPABASE_URL + '/functions/v1/sso-login', { method: 'POST', headers: { 'content-type': 'application/json', apikey: C.SUPABASE_KEY }, body: JSON.stringify({ assertion: token }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.token_hash) throw new Error(j.error || 'Sign-in with your Proview account failed. Please try again.');
    const cur = (await O.sb.auth.getSession()).data.session?.user;
    if (cur && String(cur.email || '').toLowerCase() !== j.email) await O.sb.auth.signOut();
    const v = await O.sb.auth.verifyOtp({ token_hash: j.token_hash, type: 'magiclink' });
    if (v.error) throw v.error;
  }

  A.doLogin = async () => {
    const email = $('#lgId').value.trim().toLowerCase(), pw = $('#lgPw').value;
    LG.id = email; LG.err = ''; LG.ok = '';
    if (!email || !pw) { LG.err = 'Enter your email and your password.'; return renderLogin(); }
    setLoading('Signing in…');
    const { data, error } = await O.sb.auth.signInWithPassword({ email, password: pw });
    if (error) {
      setLoading('');
      let msg = friendly(error);
      if (/Invalid login/i.test(error.message || '')) msg = 'That email or password isn’t right. If you were invited, open the sign-in link in your invite email first, or use “Forgot password?”.';
      if (/Email not confirmed/i.test(error.message || '')) { LG.unconfirmed = email; msg += ' <button type="button" class="lg-link" data-act="peResend">Send it again</button>'; }
      LG.err = ''; LG.errHtml = msg; renderLogin(); showErrHtml(); return;
    }
    await afterSignIn(data.user);
  };
  function showErrHtml() { const slot = $('#login form > div:nth-of-type(2)'); if (slot && LG.errHtml) slot.innerHTML = `<div class="lg-err" role="alert">${LG.errHtml}</div>`; LG.errHtml = ''; }
  A.peResend = async () => {
    const email = LG.unconfirmed || LG.su?.email; if (!email) return;
    const { error } = await O.sb.auth.resend({ type: 'signup', email, options: { emailRedirectTo: HERE } });
    toast(error ? friendly(error) : 'Confirmation email sent again', error ? 'bad' : undefined);
  };

  A.doSignup = async () => {
    const v = (id) => $('#' + id).value.trim();
    const name = v('suName'), org = v('suOrg'), email = v('suEmail').toLowerCase(), pw = $('#suPw').value, pw2 = $('#suPw2').value;
    LG.su = { name, org, email };
    const fail = (m) => { LG.err = m; renderLogin(); $('#suPw').value = pw; $('#suPw2').value = pw2; };
    if (!name || !org || !email) return fail('Fill in your name, company name and email.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('Enter a valid email address.');
    if (pw.length < 8) return fail('Use at least 8 characters for your password.');
    if (pw !== pw2) return fail('The two passwords don’t match. Please type them again.');
    LG.err = ''; setLoading('Creating your account…');
    const { data, error } = await O.sb.auth.signUp({ email, password: pw, options: { emailRedirectTo: HERE, data: { name, company: org, pwSet: true } } });
    setLoading('');
    if (error) return fail(friendly(error));
    if (data.session && data.user) { await afterSignIn(data.user); return; }
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) return fail('There’s already an account with that email. Sign in instead.');
    LG.mode = 'signin'; LG.id = email; LG.unconfirmed = email;
    LG.ok = `<b>Check your email.</b> We’ve sent a link to ${esc(email)}. Click it to finish creating your account. <button type="button" class="lg-link" data-act="peResend">Send it again</button>`;
    renderLogin();
  };

  A.lgForgot = () => openModal(`<div class="pad"><div class="row between"><b style="font-size:17px">Forgot your password?</b><button class="icon-btn" data-act="closeModal">${ic('x')}</button></div><p class="mut">Enter your email and we’ll send you a link to choose a new password.</p><label class="f">Email</label><input class="inp" type="email" id="fgEmail" value="${esc(($('#lgId')?.value || LG.id || '').trim())}" autocomplete="email"><div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn pri" data-act="peSendReset">Send reset link</button></div></div>`, 420);
  A.peSendReset = async () => {
    const email = $('#fgEmail').value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('Enter a valid email address', 'bad');
    const { error } = await O.sb.auth.resetPasswordForEmail(email, { redirectTo: HERE });
    if (error) return toast(friendly(error), 'bad');
    A.closeModal(); LG.ok = `<b>Check your email.</b> If there’s an account for ${esc(email)}, we’ve sent a link to choose a new password.`; LG.err = ''; renderLogin();
  };

  // choosing / changing a password
  A.forcePw = () => openModal(`<div class="pad"><b style="font-size:17px">Choose your password</b><p class="mut" style="margin:6px 0 4px">You’ll use this with your email to sign in from now on.</p><label class="f">New password</label><input class="inp" type="password" id="fpw1" autocomplete="new-password" placeholder="At least 8 characters"><label class="f">Confirm new password</label><input class="inp" type="password" id="fpw2" autocomplete="new-password"><div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn pri" data-act="forcePwSave">Save password</button></div></div>`, 420);
  async function setPassword(a, b) {
    if (a.length < 8) { toast('Use at least 8 characters', 'bad'); return false; }
    if (a !== b) { toast('Passwords don’t match', 'bad'); return false; }
    const { error } = await O.sb.auth.updateUser({ password: a, data: { pwSet: true } });
    if (error) { toast(friendly(error), 'bad'); return false; }
    toast('Password saved'); return true;
  }
  A.forcePwSave = async () => { if (await setPassword($('#fpw1').value, $('#fpw2').value)) A.closeModal(); };
  A.sSavePw = async () => { if (await setPassword($('#npw1').value, $('#npw2').value)) closeDrawer(); };

  A.signOut = async () => {
    try { localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
    if (O.queue.size) { try { await push(); } catch (e) {} }
    if (O.channel) O.sb.removeChannel(O.channel);
    if (!O.queue.size) lsDel(queueKey());
    lsDel(cacheKey());
    O.ready = false; O.org = null; O.member = null; O.role = null; O.rows = new Map(); O.snap = new Map(); O.queue = new Map(); O.linked = null; O.invited = new Set();
    await O.sb.auth.signOut().catch(() => {});
    closeDrawer(); A.closeModal(); A.navClose?.();
    S = finishState(stateFromRows([]));
    LG = { id: '', show: false, err: '', keep: true }; render();
  };

  /* ---------------- hooks into the app ---------------- */
  // saving: keep the device-only dark mode locally, send everything else
  const _save = save;
  save = function () {
    if (!O.ready) return;           // never write the demo data to this device once online
    lsSet('pe-dark', !!S.settings?.dark);
    noteChanges();
  };
  // signed-in user = the member linked to my account
  window.peRealMember = () => (O.ready ? O.member : null);

  // members: invite people as they're added with an email
  ['saveMember', 'confirmMembers', 'saveMembers'].forEach((n) => {
    const f = A[n]; if (typeof f !== 'function') return;
    A[n] = function () { const r = f.apply(this, arguments); setTimeout(inviteNew, 300); return r; };
  });

  // payslips and P45s: files live in storage, not inside the records
  async function uploadDataUrl(member, id, dataUrl, name) {
    const blob = await (await fetch(dataUrl)).blob();
    const ext = (/\.(\w+)$/.exec(name || '') || [, 'pdf'])[1].toLowerCase();
    const path = `${O.org}/${member}/${id}.${ext}`;
    const { error } = await O.sb.storage.from('pe-files').upload(path, blob, { upsert: true, contentType: blob.type || 'application/pdf' });
    if (error) throw error;
    return path;
  }
  async function fileUrl(d, download) {
    if (d.data) return docUrl(d);
    if (!d.path) throw new Error('This file isn’t available');
    const { data, error } = await O.sb.storage.from('pe-files').createSignedUrl(d.path, 300, download ? { download: d.name || true } : undefined);
    if (error) throw error;
    return data.signedUrl;
  }
  const markSeen = (d) => { if (!d.viewedAt && d.member === S.me) { d.viewedAt = Date.now(); save(); render(); } };
  A.sDocView = async (el) => {
    const d = S.docs.find((x) => x.id === el.dataset.id); if (!d) return;
    const w = window.open('', '_blank');
    try { const u = await fileUrl(d); if (w) w.location = u; else location.href = u; markSeen(d); }
    catch (e) { if (w) w.close(); toast(friendly(e), 'bad'); }
  };
  A.sDocDl = async (el) => {
    const d = S.docs.find((x) => x.id === el.dataset.id); if (!d) return;
    try { const u = await fileUrl(d, true); const a = document.createElement('a'); a.href = u; a.download = d.name || d.type + '.pdf'; document.body.appendChild(a); a.click(); a.remove(); markSeen(d); toast(`${d.type === 'P45' ? 'P45' : 'Payslip'} downloaded`); }
    catch (e) { toast(friendly(e), 'bad'); }
  };
  A.p45Save = () => {
    if (!D.member) return toast('Choose a member', 'bad');
    const ps = D.type === 'Payslip'; const dt = ps ? D.payDate : D.leaveDate;
    if (!dt) return toast(ps ? 'Choose the pay date' : 'Choose the leaving date', 'bad');
    const f = $('#p45File').files[0]; if (!f) return toast('Choose a PDF file', 'bad');
    if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) return toast('The file must be a PDF', 'bad');
    if (f.size > 10 * 1024 * 1024) return toast('That file is over 10 MB', 'bad');
    const d0 = { ...D }, id = uid();
    const btn = document.querySelector('[data-act="p45Save"]'); if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
    (async () => {
      try {
        const path = `${O.org}/${d0.member}/${id}.pdf`;
        const { error } = await O.sb.storage.from('pe-files').upload(path, f, { upsert: true, contentType: 'application/pdf' });
        if (error) throw error;
        const base = { id, member: d0.member, type: d0.type, taxYear: taxYearOf(dt), name: f.name, size: f.size, path, uploadedAt: Date.now(), uploadedBy: S.me, viewedAt: null };
        S.docs.push(ps ? { ...base, payDate: dt, period: new Date(dt + 'T12:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) } : { ...base, leaveDate: dt });
        save(); closeDrawer(); render(); toast(`${ps ? 'Payslip' : 'P45'} added for ${mem(d0.member).name}`);
      } catch (e) { toast(friendly(e), 'bad'); if (btn) { btn.disabled = false; btn.textContent = 'Upload'; } }
    })();
  };
  const _p45Del = A.p45Del;
  A.p45Del = (el) => {
    const d = S.docs.find((x) => x.id === el.dataset.id);
    const path = d?.path;
    _p45Del(el);
    // remove the file once the record is gone
    if (path) setTimeout(() => { if (!S.docs.some((x) => x.path === path)) O.sb.storage.from('pe-files').remove([path]).catch(() => {}); }, 8000);
  };

  // dark mode is per device
  const _mDark = A.mDark, _toggleDark = A.toggleDark;
  if (_mDark) A.mDark = function () { const r = _mDark.apply(this, arguments); lsSet('pe-dark', !!S.settings.dark); return r; };
  if (_toggleDark) A.toggleDark = function () { const r = _toggleDark.apply(this, arguments); lsSet('pe-dark', !!S.settings.dark); return r; };

  // lookups of people I'm not allowed to see return a neutral placeholder instead of breaking the page
  const _mem = mem;
  mem = function (id) { const m = _mem(id); if (m || !O.ready || !id) return m; return { id, name: 'Team member', role: 'Member', color: '#8b8b95', archived: false, group: '', email: '', phone: '', placeholder: true }; };

  /* ---------------- sync status dot (top bar) ---------------- */
  let syncState = 'synced';
  function setSync(st) {
    syncState = st;
    const el = document.getElementById('peSync'); if (el) paintSync(el);
  }
  function paintSync(el) {
    const t = { synced: 'Saved', saving: 'Saving…', offline: 'Offline — changes will be sent when you’re back online', error: 'Couldn’t save — retrying' }[syncState];
    el.className = 'pe-sync ' + syncState; el.title = t; el.setAttribute('aria-label', t);
  }
  const _renderTop = renderTop;
  renderTop = function () {
    _renderTop();
    if (!O.ready) return;
    const top = $('#top'); if (!top) return;
    const dot = document.createElement('span'); dot.id = 'peSync'; dot.setAttribute('role', 'status'); paintSync(dot);
    const sp = top.querySelector('.sp'); if (sp) sp.after(dot); else top.appendChild(dot);
  };
  const css = document.createElement('style');
  css.textContent = `.pe-sync{width:9px;height:9px;border-radius:50%;background:#12a150;flex:none;margin:0 6px}.pe-sync.saving{background:#4a6cd0;animation:pePulse 1s infinite}.pe-sync.offline{background:#d48a00}.pe-sync.error{background:#d92d20}@keyframes pePulse{50%{opacity:.35}}
.lg-ok{background:#ecfdf3;border:1px solid #b7ebc9;color:#0b6b34;border-radius:9px;padding:9px 11px;font-size:13.5px;line-height:1.45}
.lg-err .lg-link,.lg-ok .lg-link{background:none;border:0;padding:0;color:inherit;font:inherit;font-weight:700;text-decoration:underline;cursor:pointer}`;
  document.head.appendChild(css);

  /* ---------------- start ---------------- */
  // the online version never uses data kept in this browser by the old browser-only version: remove it
  try { localStorage.removeItem(KEY); localStorage.removeItem('pe-session'); sessionStorage.removeItem('pe-session'); } catch (e) {}

  S = finishState(stateFromRows([]));
  try { localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
  setLoading('Loading…');
  render();

  (async () => {
    try { if (!window.supabase) await loadScript(SB_JS); }
    catch (e) { setLoading(''); LG.err = 'Can’t reach the server. Check your internet connection and reload.'; renderLogin(); return; }
    O.sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' } });
    const pv = location.hash.match(/[#&]pv_sso=([^&]+)/);
    let pvErr = '';
    if (pv) {
      history.replaceState(null, '', location.pathname + location.search);
      setLoading('Signing in with your Proview account…');
      try { await pvSso(pv[1]); } catch (e) { pvErr = e.message || String(e); }
    }
    let started = false;
    O.sb.auth.onAuthStateChange((ev, session) => {
      if (ev === 'PASSWORD_RECOVERY') { setTimeout(() => A.forcePw(), 500); }
      if ((ev === 'SIGNED_IN' || ev === 'INITIAL_SESSION') && session?.user && !O.ready && !started) {
        started = true; setTimeout(() => afterSignIn(session.user).finally(() => { started = false; if (O.ready) loadInviteState().catch(() => {}); }), 0);
      }
      if (ev === 'INITIAL_SESSION' && !session) { setLoading(''); }
      if (ev === 'SIGNED_OUT' && O.ready) { A.signOut(); }
    });
    if (pvErr) { setLoading(''); LG.err = pvErr; renderLogin(); }
    const qs = new URLSearchParams(location.search);
    const err = qs.get('error_description') || new URLSearchParams(location.hash.slice(1)).get('error_description');
    if (err) { LG.err = 'That link didn’t work: ' + err + '. Sign in below, or use “Forgot password?”.'; history.replaceState(null, '', location.pathname); renderLogin(); }
  })();
})();
