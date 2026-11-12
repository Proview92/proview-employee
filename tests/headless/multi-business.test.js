// Headless tests: a person in several businesses (MULTI_BUSINESS_PICKER_STANDARD.md), no Locations page,
// Organization → "This location", and business licence wording.
// Usage: node tests/headless/multi-business.test.js [web root]   (needs Playwright + Chrome, see harness.js)
const path = require('path');
const H = require('./harness.js');
const ROOT = process.argv[2] || path.join(__dirname, '../..');
const BASE = 'http://127.0.0.1:8852/';
const SUPA = 'xcuxrcvebbtmhttruulz.supabase.co', SKEY = 'sb-xcuxrcvebbtmhttruulz-auth-token';
const A = 'aaaa1111aaaa1111aaaa1111aaaa1111', B = 'bbbb2222bbbb2222bbbb2222bbbb2222';
const U = (id, email) => ({ id, email, aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email' }, user_metadata: { pwSet: true } });
const master = U('u-master', 'master@proview.test'), multi = U('u-multi', 'Multi@Both.test'), solo = U('u-solo', 'solo@cafe-a.test');
const row = (org, coll, id, data, member_id = null) => ({ org_id: org, coll, id, member_id, data: { id, ...data }, deleted: false, updated_at: '2026-11-11T10:00:00Z' });
const loc = (org, id, name, extra = {}) => row(org, 'locations', id, { name, address: name + ' Road', lat: 51.5, lng: -0.12, radius: 300, archived: false, ...extra });
const INIT = {
  pe_masters: [{ user_id: 'u-master' }],
  pe_orgs: [{ id: A, name: 'Cafe Alpha' }, { id: B, name: 'Burger Bros Ltd' }],
  pe_people: [{ org_id: A, user_id: 'u-multi', member_id: 'm-multi-a', role: 'Owner', site_ids: null }, { org_id: B, user_id: 'u-multi', member_id: 'm-multi-b', role: 'Owner', site_ids: null },
              { org_id: A, user_id: 'u-solo', member_id: 'm-solo', role: 'Owner', site_ids: null }],
  pe_rows: [row(A, 'org', 'org', { name: 'Cafe Alpha' }), loc(A, 'l1', 'Alpha High St'), loc(A, 'l2', 'Alpha Station'),
    row(A, 'members', 'm-multi-a', { name: 'Mo Multi', role: 'Owner', email: 'multi@both.test' }, 'm-multi-a'), row(A, 'members', 'm-solo', { name: 'Sol Solo', role: 'Owner', email: 'solo@cafe-a.test' }, 'm-solo'),
    row(A, 'members', 'm-alf', { name: 'Alfie Alpha', role: 'Member', email: 'alfie@cafe-a.test' }, 'm-alf'),
    row(B, 'org', 'org', { name: 'Burger Bros Ltd' }), loc(B, 'l9', 'Bros Kitchen'),
    row(B, 'members', 'm-multi-b', { name: 'Mo Multi', role: 'Owner', email: 'multi@both.test' }, 'm-multi-b'), row(B, 'members', 'm-bob', { name: 'Bobby Bros', role: 'Member' }, 'm-bob')],
  pe_licences: [], pe_invites: [], pe_org_notes: [],
};
const tables = {};
let locked = new Set();
const reset = (f) => { for (const k of Object.keys(tables)) delete tables[k]; Object.assign(tables, JSON.parse(JSON.stringify(INIT))); locked = new Set(); if (f) f(tables); };
reset();
const isM = (u) => !!u && tables.pe_masters.some((m) => m.user_id === u.id);
const person = (u, org) => tables.pe_people.find((p) => p.user_id === u?.id && p.org_id === org);
const rls = (t, r, u) => {
  if (!u) return false; if (isM(u)) return t !== 'pe_masters' || r.user_id === u.id; if (t === 'pe_masters') return false;
  if (t === 'pe_orgs') return !!person(u, r.id);
  if (!r.org_id) return true; const p = person(u, r.org_id); if (!p || locked.has(r.org_id + '|' + u.id)) return false;
  if (t === 'pe_rows' && r.coll === 'locations' && Array.isArray(p.site_ids) && p.site_ids.length) return p.site_ids.includes(r.id);
  return true;
};
const licStatus = (org) => ({ included: 1, allowance: 10, staff: [], me: null,
  locations: tables.pe_rows.filter((r) => r.org_id === org && r.coll === 'locations' && !r.deleted).map((r) => ({ id: r.id, name: r.data.name, archived: !!r.data.archived,
    license_type: r.id === 'l2' ? null : 'lifetime', expires_at: null, ok: r.id !== 'l2' })) });
const SSO = { 'as-master-A': [master, A] };
const mock = H.makeMock({
  users: { 'tok-master': master, 'tok-multi': multi, 'tok-solo': solo }, tables, rls,
  passwords: { 'multi@both.test': multi }, passwordOf: () => 'correct-horse',
  otp: { 'h-master': master },
  rpc: {
    pe_whoami: (_, u) => tables.pe_people.filter((p) => p.user_id === u.id).map((p) => ({ org_id: p.org_id, org_name: tables.pe_orgs.find((o) => o.id === p.org_id).name, member_id: p.member_id, role: p.role,
      license_type: 'm12', license_expires_at: '2027-06-01T00:00:00Z', locked: locked.has(p.org_id + '|' + u.id), suspended: false, is_master: false })),
    pe_am_master: (_, u) => isM(u), pe_licence_status: (a) => licStatus(a.o), pe_start_trial: () => { throw new Error('Enter your company name'); },
    licence_buy_plans: () => ({}), licence_buy_plans_by_kind: () => ({ location: { m12: { label: '12 months', amount: 12000, currency: 'gbp', link: 'https://buy.stripe.test/x' } }, staff: {} }), team_people: () => [] },
  ssoLogin: (b) => { const s = SSO[b.assertion]; if (!s) return { status: 401, body: { error: 'expired' } }; return { status: 200, body: { token_hash: 'h-master', email: master.email, open: s[1] } }; },
});
const R = H.reporter();
const view = (page) => page.evaluate(() => {
  const sel = document.querySelector('#top .hdr-pick select');
  return {
    opts: sel ? [...sel.options].map((o) => o.textContent) : [], groups: sel ? sel.querySelectorAll('optgroup').length : 0,
    picked: sel ? sel.options[sel.selectedIndex]?.textContent : null, disabled: sel?.disabled ?? null, aria: sel?.getAttribute('aria-label'),
    org: window.PE_ONLINE?.org, view: typeof U !== 'undefined' ? U.view : null, title: document.querySelector('#top h2')?.textContent || '',
    nav: [...document.querySelectorAll('.side .nav > button')].filter((b) => getComputedStyle(b).display !== 'none').map((b) => b.title || b.textContent.trim()),
    main: document.querySelector('#content')?.innerText || '', bar: document.querySelector('#pvMasterBar')?.innerText || '',
    signedOut: document.body.classList.contains('signed-out'),
    last: Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith('pe-last-used:')).map((k) => [k, localStorage.getItem(k)])),
    hdrText: document.querySelector('#top')?.innerText || '',
  };
});
const settle = (p, ms = 3200) => p.waitForTimeout(ms);
const lastKey = 'pe-last-used:multi@both.test';
const pickBiz = async (page, name) => { const v = await page.evaluate((t) => [...document.querySelector('#top .hdr-pick select').options].find((o) => o.textContent === t)?.value, name); await page.selectOption('#top .hdr-pick select', v); };
const goView = (page, v) => page.evaluate((v) => { U.view = v; render(); }, v);
const noLocWords = (v) => !v.opts.some((o) => /All my locations|All locations|▸/.test(o)) && !v.groups && !/Switch location|Choose location/.test(v.hdrText);

(async () => {
  const srv = await H.serveStatic(ROOT, 8852);
  const b = await H.launch();
  try {
    // 1) two businesses, last used A
    {
      reset();
      const { page, errors, ctx } = await H.openApp(b, { base: BASE, supaHost: SUPA, mock, seed: { [SKEY]: H.storedSession('tok-multi', multi), [lastKey]: JSON.stringify(A) } });
      await page.goto(BASE); await settle(page);
      let v = await view(page);
      R.ok(v.org === A && v.picked === 'Cafe Alpha', 'sign-in: lands in the last-used business (Cafe Alpha) ' + v.picked);
      R.ok(JSON.stringify(v.opts) === JSON.stringify(['Burger Bros Ltd', 'Cafe Alpha']) && noLocWords(v), 'dropdown: business names only, by name ' + JSON.stringify(v.opts));
      R.ok(v.aria === 'Business' && v.disabled === false, 'dropdown: aria-label "Business", enabled');
      // switch to B
      let n0 = mock.log.length;
      await pickBiz(page, 'Burger Bros Ltd'); await settle(page);
      v = await view(page);
      R.ok(v.org === B && v.picked === 'Burger Bros Ltd' && JSON.parse(v.last[lastKey] || 'null') === B, 'switch: Burger Bros Ltd opens B, remembered as last used by email');
      R.ok(!H.leaks(mock.log, n0, ['Alfie Alpha', 'Alpha High St']).length, 'switch: nothing of Cafe Alpha loaded after switching to B');
      await goView(page, 'people'); await settle(page, 600); v = await view(page);
      R.ok(/Bobby Bros/.test(v.main) && !/Alfie Alpha/.test(v.main), 'B: People shows only Burger Bros people');
      // back to A: the whole business, never mixed with B
      n0 = mock.log.length;
      await pickBiz(page, 'Cafe Alpha'); await settle(page);
      await goView(page, 'people'); await settle(page, 600); v = await view(page);
      R.ok(v.org === A && /Alfie Alpha/.test(v.main) && !/Bobby Bros/.test(v.main), 'A: People shows only Cafe Alpha people');
      R.ok(!H.leaks(mock.log, n0, ['Bobby Bros', 'Bros Kitchen']).length, 'A: no Burger Bros data requested or returned');
      // no Locations page
      await page.evaluate(() => { S.settings.navSettingsOpen = true; render(); }); await settle(page, 400); v = await view(page);
      R.ok(!v.nav.some((t) => /^Locations$/.test(t)) && v.nav.includes('Organization'), 'no Locations menu item (Settings open) ' + JSON.stringify(v.nav));
      await goView(page, 'locations'); await settle(page, 500); v = await view(page);
      R.ok(v.view === 'dashboard' && v.title === 'Dashboard', 'old Locations view goes to the home page (Dashboard) ' + v.view);
      // Organization → This location: in-page location select (2 locations), save to the chosen one
      await goView(page, 'organization'); await settle(page, 600);
      v = await view(page);
      R.ok(/This location/.test(v.main) && !!(await page.$('#peThisLoc')), 'Organization: "This location" with an in-page location select (2 locations)');
      R.ok(JSON.stringify(await page.$$eval('#peThisLoc option', (o) => o.map((x) => x.textContent))) === JSON.stringify(['Alpha High St', 'Alpha Station']) && (await page.getAttribute('#peThisLoc', 'aria-label')) === 'Location', 'This location: select lists the business\'s locations by name, aria-label "Location"');
      await page.selectOption('#peThisLoc', 'l2'); await settle(page, 400);
      R.ok((await page.inputValue('#peLocName')) === 'Alpha Station', 'This location: picking Alpha Station shows its fields');
      v = await view(page);
      R.ok(/Business licence/.test(v.main) && /Each business needs its own licence/.test(v.main) && /Buy licence online/.test(v.main) && !/Location licence|Each location needs/.test(v.main), 'This location: business licence status with Buy licence online');
      await page.fill('#peLocName', 'Alpha Station Hall'); await page.fill('#peLocRad', '450'); await page.click('[data-act=peLocSave]'); await settle(page, 2500);
      const saved = tables.pe_rows.find((r) => r.org_id === A && r.id === 'l2'), other = tables.pe_rows.find((r) => r.org_id === A && r.id === 'l1');
      R.ok(saved.data.name === 'Alpha Station Hall' && +saved.data.radius === 450 && other.data.name === 'Alpha High St', 'This location: Save writes that one location only ' + JSON.stringify(saved.data));
      await page.reload(); await settle(page); await goView(page, 'organization'); await settle(page, 600);
      R.ok((await page.inputValue('#peThisLoc').catch(() => '')) === 'l2' && (await page.inputValue('#peLocName')) === 'Alpha Station Hall', 'This location: the chosen location is remembered, the saved name reloads');
      // licence wording on the dashboard
      await goView(page, 'dashboard'); await settle(page, 600); v = await view(page);
      R.ok(/business licence/i.test(v.main) && !/licensed location|Location licence/i.test(v.main), 'dashboard licence banner: business wording ' + (v.main.match(/.{0,30}licen.{0,40}/i) || [''])[0]);
      // sign out, password sign-in: back in the last used business
      await pickBiz(page, 'Burger Bros Ltd'); await settle(page);
      await page.evaluate(() => A.signOut()); await settle(page, 1500);
      v = await view(page);
      R.ok(v.signedOut && !!v.last[lastKey], 'sign-out: sign-in page, last used business still remembered for this email');
      await page.fill('#lgId', 'multi@both.test'); await page.fill('#lgPw', 'correct-horse'); await page.evaluate(() => A.doLogin()); await settle(page);
      v = await view(page);
      R.ok(v.org === B && v.picked === 'Burger Bros Ltd' && !/choose a business/i.test(v.main), 'password sign-in: lands in Burger Bros Ltd (last used), no "choose a business" page');
      R.ok(!errors.length, 'two businesses: no page errors ' + errors.join(' | '));
      await ctx.close();
    }
    // 2) new device: the first usable business by name
    {
      reset();
      const { page, errors, ctx } = await H.openApp(b, { base: BASE, supaHost: SUPA, mock, seed: { [SKEY]: H.storedSession('tok-multi', multi) } });
      await page.goto(BASE); await settle(page);
      const v = await view(page);
      R.ok(v.org === B && v.picked === 'Burger Bros Ltd', 'new device: first usable business by name ' + v.picked);
      R.ok(!errors.length, 'new device: no page errors ' + errors.join(' | '));
      await ctx.close();
    }
    // 3) fallback when A is unusable
    for (const [why, change] of [
      ['Cafe Alpha locked', () => { locked.add(A + '|u-multi'); }],
      ['no location in Cafe Alpha', (t) => { t.pe_rows.filter((r) => r.org_id === A && r.coll === 'locations').forEach((r) => { r.data.archived = true; }); }]]) {
      reset(); change(tables);
      const { page, errors, ctx } = await H.openApp(b, { base: BASE, supaHost: SUPA, mock, seed: { [SKEY]: H.storedSession('tok-multi', multi), [lastKey]: JSON.stringify(A) } });
      await page.goto(BASE); await settle(page);
      const v = await view(page);
      R.ok(v.org === B && !v.signedOut && JSON.stringify(v.opts) === JSON.stringify(['Burger Bros Ltd']) && v.disabled === true, `fallback (${why}): opens Burger Bros Ltd, its name disabled ${JSON.stringify(v.opts)}`);
      R.ok(!errors.length, `fallback (${why}): no page errors ` + errors.join(' | '));
      await ctx.close();
    }
    // 4) single-business owner: the business name, disabled; This location works
    {
      reset();
      const { page, errors, ctx } = await H.openApp(b, { base: BASE, supaHost: SUPA, mock, seed: { [SKEY]: H.storedSession('tok-solo', solo) } });
      await page.goto(BASE); await settle(page);
      let v = await view(page);
      R.ok(v.org === A && JSON.stringify(v.opts) === JSON.stringify(['Cafe Alpha']) && v.disabled === true, 'single business: its name, disabled ' + JSON.stringify(v.opts));
      await page.evaluate(() => { S.settings.navSettingsOpen = true; render(); }); await settle(page, 300); v = await view(page);
      R.ok(!v.nav.some((t) => /^Locations$/.test(t)), 'single business: no Locations menu item');
      R.ok(!errors.length, 'single business: no page errors ' + errors.join(' | '));
      await ctx.close();
      // one location only: no in-page select, the fields are for that location
      reset((t) => { t.pe_rows = t.pe_rows.filter((r) => r.id !== 'l2'); });
      const o = await H.openApp(b, { base: BASE, supaHost: SUPA, mock, seed: { [SKEY]: H.storedSession('tok-solo', solo) } });
      await o.page.goto(BASE); await settle(o.page); await goView(o.page, 'organization'); await settle(o.page, 600);
      R.ok(!(await o.page.$('#peThisLoc')) && (await o.page.inputValue('#peLocName')) === 'Alpha High St', 'one location: no location select, "This location" is that location');
      await o.page.fill('#peLocAddr', '1 New Street'); await o.page.click('[data-act=peLocSave]'); await settle(o.page, 2500);
      R.ok(tables.pe_rows.find((r) => r.id === 'l1').data.address === '1 New Street', 'one location: Save writes it');
      R.ok(!o.errors.length, 'one location: no page errors ' + o.errors.join(' | '));
      await o.ctx.close();
    }
    // 4b) the master signed in directly: "Open a business from the licence portal"
    {
      reset();
      const { page, errors, ctx } = await H.openApp(b, { base: BASE, supaHost: SUPA, mock, seed: { [SKEY]: H.storedSession('tok-master', master) } });
      await page.goto(BASE); await settle(page);
      const t = await page.evaluate(() => document.body.innerText);
      R.ok(/Open a business from the licence portal/.test(t) && !/Open a location/.test(t), 'master direct: "Open a business from the licence portal"');
      R.ok(!errors.length, 'master direct: no page errors ' + errors.join(' | '));
      await ctx.close();
    }
    // 5) master-open unchanged (the opened business's name, disabled)
    {
      reset();
      const { page, errors, ctx } = await H.openApp(b, { base: BASE, supaHost: SUPA, mock });
      const n0 = mock.log.length; await page.goto(BASE + '#pv_sso=as-master-A'); await settle(page, 4000);
      let v = await view(page);
      R.ok(/Viewing\s+Cafe Alpha\s+as Proview/.test(v.bar) && JSON.stringify(v.opts) === JSON.stringify(['Cafe Alpha']) && v.disabled === true, 'master-open: banner, the opened business\'s name disabled ' + JSON.stringify(v.opts));
      R.ok(!H.leaks(mock.log, n0, ['Burger Bros Ltd', 'Bobby Bros', 'Bros Kitchen']).length && !Object.keys(v.last).length, 'master-open: no other business loaded, nothing remembered as last used');
      await page.evaluate(() => { S.settings.navSettingsOpen = true; render(); }); await settle(page, 300); v = await view(page);
      R.ok(!v.nav.some((t) => /^Locations$/.test(t)), 'master-open: no Locations menu item');
      await goView(page, 'organization'); await settle(page, 600); v = await view(page);
      R.ok(/This location/.test(v.main) && /Licence portal/.test(v.main), 'master-open: This location with the licence portal link');
      R.ok(!errors.length, 'master-open: no page errors ' + errors.join(' | '));
      await ctx.close();
    }
  } finally { await b.close(); srv.close(); }
  process.exit(R.done() ? 1 : 0);
})();
