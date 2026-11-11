-- Tests for 009_no_trial.sql. Run as ONE query: this setup block, then the migration, then the test block.
-- It is all one transaction that always fails at the end (results in the error message), so nothing is kept.
-- Build it with:  { sed -n '/^-- SETUP/,/^-- END SETUP/p' tests/009_no_trial_test.sql; cat 009_no_trial.sql; sed -n '/^-- TESTS/,$p' tests/009_no_trial_test.sql; }

-- SETUP (runs on the functions as they are BEFORE 009): an existing self-signup trial business
do $S$
declare u uuid := 'a0090000-0000-4000-8000-000000000001'; o text;
begin
  create or replace function pg_temp.as_(uid uuid, em text) returns void language plpgsql as $f$
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'email', em)::text, true);
    perform set_config('request.jwt.claim.sub', uid::text, true);
    execute 'set local role authenticated';
  end $f$;
  create or replace function pg_temp.svc() returns void language plpgsql as $f$
  begin
    execute 'reset role';
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
  end $f$;
  -- fingerprint of every real licence and business, to prove they are untouched
  create temp table t_before as
    select (select md5(coalesce(string_agg(l::text, '|' order by org_id, member_id), '')) from public.pe_licences l) lic,
           (select md5(coalesce(string_agg(g.id || g.name || g.self_signup, '|' order by g.id), '')) from public.pe_orgs g) orgs;
  insert into auth.users (id, email, aud, role, email_confirmed_at)
  values (u, 'pe009-oldtrial@test.invalid', 'authenticated', 'authenticated', now());
  perform pg_temp.as_(u, 'pe009-oldtrial@test.invalid');
  o := public.pe_start_trial('PE009 Old Trial', 'PE009 Old Site', 'mpe009old', 'Old Owner');
  perform pg_temp.svc();
  create temp table t_old as
    select o as org_id, l.license_type, l.expires_at from public.pe_licences l where l.org_id = o and l.member_id = 'mpe009old';
end $S$;
-- END SETUP

-- (the migration goes here)

-- TESTS
do $T$
declare
  out text := '';
  u_master uuid := (select m.user_id from public.pe_masters m join auth.users u on u.id = m.user_id where u.email = 'altun@proviewtech.co.uk');
  u_ss uuid := 'a0090000-0000-4000-8000-000000000002';
  u_ss2 uuid := 'a0090000-0000-4000-8000-000000000003';
  u_inv uuid := 'a0090000-0000-4000-8000-000000000004';
  u_old uuid := 'a0090000-0000-4000-8000-000000000001';
  r jsonb; e text; n int; w record; o text; o2 text; o3 text; o4 text; ov jsonb; l public.pe_licences; old record;
  ok boolean;
begin
  if u_master is null then raise exception 'no master'; end if;
  insert into auth.users (id, email, aud, role, email_confirmed_at) values
    (u_ss,  'pe009-self@test.invalid',  'authenticated', 'authenticated', now()),
    (u_ss2, 'pe009-self2@test.invalid', 'authenticated', 'authenticated', now());
  -- pretend u_ss2 already had a trial in the past: the one-trial-per-email record no longer matters
  insert into public.pe_trial_emails (email) values ('pe009-self2@test.invalid');

  -- 1. master + Add business (pe_add_business)
  perform pg_temp.as_(u_master, 'altun@proviewtech.co.uk');
  r := public.pe_add_business('PE009 Added Cafe', 'Sam Taylor', 'pe009-added@test.invalid', '', 'secret12');
  perform pg_temp.svc();
  o := r->>'org_id';
  select * into l from public.pe_licences where org_id = o and member_id = r->>'member_id';
  out := out || format(E'\n%s Add business: owner has NO licence (type %s, expires %s)', case when l.org_id is not null and l.license_type is null and l.expires_at is null then 'PASS' else 'FAIL' end, l.license_type, l.expires_at);
  select count(*) into n from public.pe_rows where org_id = o and coll = 'locations' and not deleted;
  out := out || format(E'\n%s Add business: one location (%s)', case when n = 1 then 'PASS' else 'FAIL' end, n);
  select count(*) into n from public.pe_licences where org_id = o and license_type is not null;
  out := out || format(E'\n%s Add business: no licence anywhere in the business (%s)', case when n = 0 then 'PASS' else 'FAIL' end, n);
  perform pg_temp.as_((r->>'user_id')::uuid, 'pe009-added@test.invalid');
  select * into w from public.pe_whoami() x limit 1;
  select count(*) into n from public.pe_rows where org_id = o;
  perform pg_temp.svc();
  out := out || format(E'\n%s Add business: owner can sign in (whoami lists it, Owner) but is locked (locked=%s) and sees no rows (%s)',
    case when w.org_id = o and w.role = 'Owner' and w.locked and w.license_type is null and n = 0 then 'PASS' else 'FAIL' end, w.locked, n);
  -- the locked owner can't add staff
  begin
    perform pg_temp.as_((r->>'user_id')::uuid, 'pe009-added@test.invalid');
    insert into public.pe_rows (org_id, coll, id, member_id, data) values (o, 'members', 'mpe009x', 'mpe009x', '{"id":"mpe009x","name":"X","role":"Member"}');
    perform pg_temp.svc();
    out := out || E'\nFAIL locked owner could add staff';
  exception when others then
    perform pg_temp.svc();
    out := out || E'\nPASS locked owner can''t add staff (' || left(sqlerrm, 60) || ')';
  end;
  -- staff added (e.g. by Proview) follow the owner: no licence
  insert into public.pe_rows (org_id, coll, id, member_id, data) values (o, 'members', 'mpe009s1', 'mpe009s1',
    '{"id":"mpe009s1","name":"Staff One","role":"Member","email":"pe009-s1@test.invalid"}');
  select * into l from public.pe_licences where org_id = o and member_id = 'mpe009s1';
  out := out || format(E'\n%s new staff: no licence, follows the owner (type %s, follows %s)', case when l.license_type is null and l.expires_at is null and l.follows_owner then 'PASS' else 'FAIL' end, l.license_type, l.follows_owner);
  begin
    insert into public.pe_rows (org_id, coll, id, member_id, data) values (o, 'entries', 'epe009', 'mpe009s1', '{"id":"epe009"}');
    out := out || E'\nFAIL unlicensed staff could clock in';
  exception when others then
    out := out || E'\nPASS unlicensed staff can''t clock in (' || left(sqlerrm, 50) || ')';
  end;
  -- the owner's licence is bought (hub_call 'set' writes pe_licences): staff follow it
  update public.pe_licences set license_type = 'm12', starts_at = now(), expires_at = now() + interval '12 months', updated_at = now()
   where org_id = o and member_id = r->>'member_id';
  select * into l from public.pe_licences where org_id = o and member_id = 'mpe009s1';
  out := out || format(E'\n%s owner buys m12: staff follow (type %s, ends in ~%s days)', case when l.license_type = 'm12' and l.expires_at > now() + interval '360 days' then 'PASS' else 'FAIL' end, l.license_type, extract(day from l.expires_at - now()));
  perform pg_temp.as_((r->>'user_id')::uuid, 'pe009-added@test.invalid');
  select * into w from public.pe_whoami() x limit 1;
  perform pg_temp.svc();
  out := out || format(E'\n%s owner unlocked once licensed (locked=%s)', case when not w.locked then 'PASS' else 'FAIL' end, w.locked);

  -- 2. self-signup ("Set up your business", pe_start_trial)
  perform pg_temp.as_(u_ss, 'pe009-self@test.invalid');
  o2 := public.pe_start_trial('PE009 Self Biz', 'PE009 Self Site', 'mpe009self', 'Self Owner');
  select * into w from public.pe_whoami() x limit 1;
  perform pg_temp.svc();
  select * into l from public.pe_licences where org_id = o2 and member_id = 'mpe009self';
  out := out || format(E'\n%s self-signup: owner has NO licence (type %s, expires %s)', case when l.org_id is not null and l.license_type is null and l.expires_at is null then 'PASS' else 'FAIL' end, l.license_type, l.expires_at);
  out := out || format(E'\n%s self-signup: Owner, locked (role %s, locked %s)', case when w.org_id = o2 and w.role = 'Owner' and w.locked then 'PASS' else 'FAIL' end, w.role, w.locked);
  select count(*) into n from public.pe_rows where org_id = o2 and coll = 'locations' and data->>'name' = 'PE009 Self Site';
  out := out || format(E'\n%s self-signup: first location made (%s)', case when n = 1 then 'PASS' else 'FAIL' end, n);
  select count(*) into n from public.pe_trial_emails where email = 'pe009-self@test.invalid';
  out := out || format(E'\n%s self-signup: no one-trial-per-email record written (%s)', case when n = 0 then 'PASS' else 'FAIL' end, n);
  -- trial email already used: still allowed (no longer relied on), still no licence
  perform pg_temp.as_(u_ss2, 'pe009-self2@test.invalid');
  o3 := public.pe_start_trial('PE009 Self Biz 2', '', 'mpe009self2', null);
  perform pg_temp.svc();
  select * into l from public.pe_licences where org_id = o3 and member_id = 'mpe009self2';
  out := out || format(E'\n%s self-signup with an email in pe_trial_emails: allowed, no licence (type %s)', case when o3 is not null and l.org_id is not null and l.license_type is null then 'PASS' else 'FAIL' end, l.license_type);
  -- someone already in a business is refused
  begin
    perform pg_temp.as_(u_ss, 'pe009-self@test.invalid');
    perform public.pe_start_trial('PE009 Again', '', 'mpe009again', null);
    perform pg_temp.svc();
    out := out || E'\nFAIL second business for the same person';
  exception when others then
    perform pg_temp.svc();
    out := out || E'\nPASS someone with a business can''t set up another (' || left(sqlerrm, 45) || ')';
  end;

  -- 3. old functions
  -- pe_create_org (non-master -> pe_start_trial)
  insert into auth.users (id, email, aud, role, email_confirmed_at) values
    ('a0090000-0000-4000-8000-000000000005', 'pe009-co@test.invalid', 'authenticated', 'authenticated', now());
  perform pg_temp.as_('a0090000-0000-4000-8000-000000000005', 'pe009-co@test.invalid');
  o4 := public.pe_create_org('PE009 CreateOrg', 'mpe009co');
  perform pg_temp.svc();
  select * into l from public.pe_licences where org_id = o4 and member_id = 'mpe009co';
  out := out || format(E'\n%s pe_create_org (self): no licence (type %s)', case when l.org_id is not null and l.license_type is null then 'PASS' else 'FAIL' end, l.license_type);
  -- pe_master_create_org (master, invite) and the invited owner signing in
  perform pg_temp.as_(u_master, 'altun@proviewtech.co.uk');
  o4 := public.pe_master_create_org('PE009 MasterCreate', 'Inv Owner', 'pe009-inv@test.invalid', null);
  perform pg_temp.svc();
  select count(*) into n from public.pe_licences where org_id = o4 and license_type is null;
  ok := n = 1 and not exists (select 1 from public.pe_licences where org_id = o4 and license_type is not null);
  out := out || format(E'\n%s pe_master_create_org: owner member has no licence (%s)', case when ok then 'PASS' else 'FAIL' end, n);
  insert into auth.users (id, email, aud, role, email_confirmed_at) values (u_inv, 'pe009-inv@test.invalid', 'authenticated', 'authenticated', now());
  perform pg_temp.as_(u_inv, 'pe009-inv@test.invalid');
  select * into w from public.pe_whoami() x where x.org_id = o4;
  perform pg_temp.svc();
  out := out || format(E'\n%s pe_master_create_org: invited owner signs in, Owner, locked (%s %s)', case when w.role = 'Owner' and w.locked then 'PASS' else 'FAIL' end, w.role, w.locked);
  -- master pe_create_org (older All sites path)
  perform pg_temp.as_(u_master, 'altun@proviewtech.co.uk');
  o4 := public.pe_create_org('PE009 MasterOrg', 'mpe009mo');
  perform pg_temp.svc();
  select count(*) into n from public.pe_licences where org_id = o4 and license_type is not null;
  out := out || format(E'\n%s master pe_create_org: no licence in the business (%s licensed)', case when n = 0 and exists (select 1 from public.pe_licences where org_id = o4) then 'PASS' else 'FAIL' end, n);

  -- 4. a new location in an existing business carries no licence (Employee licences are per person); a new
  --    staff member in an existing business Proview added (doesn't follow the owner) gets no trial either
  insert into public.pe_orgs (id, name, self_signup, staff_follow_owner) values ('pe009old2', 'PE009 Existing Proview', false, false);
  -- (written with the master's claims but the table owner's rights, as Proview's own functions do)
  perform set_config('request.jwt.claim.sub', u_master::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', u_master, 'role', 'authenticated')::text, true);
  insert into public.pe_rows (org_id, coll, id, member_id, data) values ('pe009old2', 'members', 'mpe009o2', 'mpe009o2', '{"id":"mpe009o2","name":"O","role":"Owner"}');
  perform pg_temp.svc();
  insert into public.pe_rows (org_id, coll, id, member_id, data) values ('pe009old2', 'locations', 'lpe009o2', null, '{"id":"lpe009o2","name":"Later location"}');
  insert into public.pe_rows (org_id, coll, id, member_id, data) values ('pe009old2', 'members', 'mpe009o2s', 'mpe009o2s', '{"id":"mpe009o2s","name":"S","role":"Member"}');
  select * into l from public.pe_licences where org_id = 'pe009old2' and member_id = 'mpe009o2s';
  out := out || format(E'\n%s existing (Proview-added) business: new staff get no trial (type %s, follows %s)', case when l.org_id is not null and l.license_type is null and not l.follows_owner then 'PASS' else 'FAIL' end, l.license_type, l.follows_owner);
  select count(*) into n from public.pe_licences where org_id = 'pe009old2' and license_type is not null;
  out := out || format(E'\n%s location added later: no licence created (%s)', case when n = 0 then 'PASS' else 'FAIL' end, n);

  -- 5. an existing trial business is unchanged
  select * into old from t_old;
  select * into l from public.pe_licences where org_id = old.org_id and member_id = 'mpe009old';
  out := out || format(E'\n%s existing trial business: owner keeps trial3 and its expiry (%s %s)', case when l.license_type = 'trial3' and old.license_type = 'trial3' and l.expires_at = old.expires_at then 'PASS' else 'FAIL' end, l.license_type, l.expires_at);
  out := out || format(E'\n%s existing trial business: still follows its owner', case when public.pe_trial_owner(old.org_id) = 'mpe009old' then 'PASS' else 'FAIL' end);
  insert into public.pe_rows (org_id, coll, id, member_id, data) values (old.org_id, 'members', 'mpe009olds', 'mpe009olds', '{"id":"mpe009olds","name":"S","role":"Member"}');
  select * into l from public.pe_licences where org_id = old.org_id and member_id = 'mpe009olds';
  out := out || format(E'\n%s existing trial business: new staff end with the owner (%s, same end %s)', case when l.license_type = 'trial3' and l.expires_at = old.expires_at and l.follows_owner then 'PASS' else 'FAIL' end, l.license_type, l.expires_at = old.expires_at);

  -- 6. master overview flags
  perform pg_temp.as_(u_master, 'altun@proviewtech.co.uk');
  ov := public.pe_master_overview();
  perform pg_temp.svc();
  out := out || format(E'\n%s overview: licensed_ever false for a new business, true for the old trial',
    case when (select (x->>'licensed_ever')::boolean from jsonb_array_elements(ov) x where x->>'id' = o2) = false
          and (select (x->>'licensed_ever')::boolean from jsonb_array_elements(ov) x where x->>'id' = old.org_id) = true then 'PASS' else 'FAIL' end);

  -- 7. non-master still refused
  perform pg_temp.as_(u_ss, 'pe009-self@test.invalid');
  begin perform public.pe_add_business('PE009 Nope', 'No One', 'pe009-nope@test.invalid', '', 'secret12'); e := 'allowed';
  exception when others then e := sqlerrm; end;
  out := out || format(E'\n%s non-master pe_add_business refused (%s)', case when e like 'Only the master%' then 'PASS' else 'FAIL' end, e);
  begin perform public.pe_master_create_org('PE009 Nope', 'No One', 'pe009-nope@test.invalid', null); e := 'allowed';
  exception when others then e := sqlerrm; end;
  out := out || format(E'\n%s non-master pe_master_create_org refused (%s)', case when e like 'Only the master%' then 'PASS' else 'FAIL' end, e);
  begin perform public.pe_master_overview(); e := 'allowed';
  exception when others then e := sqlerrm; end;
  out := out || format(E'\n%s non-master pe_master_overview refused (%s)', case when e like 'Only the master%' then 'PASS' else 'FAIL' end, e);
  begin perform public.pe_give_trial(o2, 'mpe009z', 'z'); e := 'allowed';
  exception when others then e := sqlerrm; end;
  out := out || format(E'\n%s pe_give_trial not callable by users (%s)', case when e like 'permission denied%' then 'PASS' else 'FAIL' end, left(e, 40));
  perform pg_temp.svc();

  -- 8. real businesses and licences untouched (test rows excluded)
  select (t.lic = (select md5(coalesce(string_agg(l2::text, '|' order by org_id, member_id), '')) from public.pe_licences l2
                    where not exists (select 1 from public.pe_orgs g where g.id = l2.org_id and g.name like 'PE009 %')))
     and (t.orgs = (select md5(coalesce(string_agg(g.id || g.name || g.self_signup, '|' order by g.id), '')) from public.pe_orgs g where g.name not like 'PE009 %'))
    into ok from t_before t;
  out := out || format(E'\n%s real businesses and licences unchanged', case when ok then 'PASS' else 'FAIL' end);

  raise exception 'ROLLBACK (test only)%', out;
end $T$;
