-- Test for 007_staff_follow_business_trial.sql. Run AFTER 007 is applied (or paste 007 above it inside the
-- same transaction). Everything is rolled back: the final error message IS the PASS/FAIL report.
do $T$
declare
  out text := ''; uid uuid := gen_random_uuid(); master uuid := (select user_id from public.pe_masters limit 1);
  o text; o2 text := 'pe007other'; own text; l public.pe_licences; s public.pe_licences; ok boolean;
begin
  insert into auth.users(id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
  values (uid,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','pe007-owner@test.invalid',now(),now(),now());

  -- the owner starts a self-signup trial
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'email', 'pe007-owner@test.invalid')::text, true);
  perform set_config('request.jwt.claim.sub', uid::text, true);
  execute 'set local role authenticated';
  o := public.pe_start_trial('PE007 Burger', 'Branch 1', 'mOwn', 'Olive Owner');
  execute 'reset role';
  own := public.pe_trial_owner(o);
  select * into l from public.pe_licences where org_id = o and member_id = own;
  out := out || format(E'\n%s owner gets a 3-day trial (%s, ends %s)', case when l.license_type = 'trial3' and abs(extract(epoch from (l.expires_at - (now() + interval '3 days')))) < 120 then 'PASS' else 'FAIL' end, l.license_type, l.expires_at);

  -- staff added as master (skips the app's access checks; triggers still run)
  perform set_config('request.jwt.claims', json_build_object('sub', master, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', master::text, true);
  insert into public.pe_rows(org_id, coll, id, member_id, data) values (o, 'members', 'mS1', 'mS1', '{"name":"Sam Staff","role":"Member","email":"sam@test.invalid"}');
  select * into s from public.pe_licences where org_id = o and member_id = 'mS1';
  out := out || format(E'\n%s new staff licence = owner''s type and end date, following (%s %s %s)', case when s.license_type = l.license_type and s.expires_at = l.expires_at and s.follows_owner then 'PASS' else 'FAIL' end, s.license_type, s.expires_at, s.follows_owner);

  -- 1. owner bought a paid licence (as the licence portal would)
  update public.pe_licences set license_type = 'm12', expires_at = now() + interval '1 year' where org_id = o and member_id = own;
  select * into l from public.pe_licences where org_id = o and member_id = own;
  select * into s from public.pe_licences where org_id = o and member_id = 'mS1';
  out := out || format(E'\n%s owner paid -> staff follow type and end date (%s %s)', case when s.license_type = 'm12' and s.expires_at = l.expires_at and s.follows_owner then 'PASS' else 'FAIL' end, s.license_type, s.expires_at);

  -- 2. staff added after paying end the same as the owner
  insert into public.pe_rows(org_id, coll, id, member_id, data) values (o, 'members', 'mS2', 'mS2', '{"name":"Pat Staff","role":"Member","email":"pat@test.invalid"}');
  select * into s from public.pe_licences where org_id = o and member_id = 'mS2';
  out := out || format(E'\n%s staff added after paying get the owner''s licence (%s %s)', case when s.license_type = 'm12' and s.expires_at = l.expires_at then 'PASS' else 'FAIL' end, s.license_type, s.expires_at);

  -- 3. grace period: owner 3 days past the end (within 7-day grace) -> staff still in, same as owner
  update public.pe_licences set expires_at = now() - interval '3 days' where org_id = o and member_id = own;
  out := out || format(E'\n%s within grace: owner %s, staff %s (must match, both in)', case when public.pe_member_licensed(o, own) and public.pe_member_licensed(o, 'mS1') and public.pe_member_licensed(o, 'mS2') then 'PASS' else 'FAIL' end, public.pe_member_licensed(o, own), public.pe_member_licensed(o, 'mS1'));
  update public.pe_licences set expires_at = now() - interval '10 days' where org_id = o and member_id = own;
  out := out || format(E'\n%s past grace: owner %s, staff %s (must match, both out)', case when not public.pe_member_licensed(o, own) and not public.pe_member_licensed(o, 'mS1') then 'PASS' else 'FAIL' end, public.pe_member_licensed(o, own), public.pe_member_licensed(o, 'mS1'));

  -- lifetime owner -> lifetime staff
  update public.pe_licences set license_type = 'lifetime', expires_at = null where org_id = o and member_id = own;
  select * into s from public.pe_licences where org_id = o and member_id = 'mS1';
  out := out || format(E'\n%s lifetime owner -> staff lifetime (%s %s, licensed %s)', case when s.license_type = 'lifetime' and s.expires_at is null and public.pe_member_licensed(o, 'mS1') then 'PASS' else 'FAIL' end, s.license_type, s.expires_at, public.pe_member_licensed(o, 'mS1'));

  -- a staff licence set explicitly in the licence portal stops following
  update public.pe_licences set license_type = 'm1', expires_at = now() + interval '1 month' where org_id = o and member_id = 'mS2';
  update public.pe_licences set license_type = 'm12', expires_at = now() + interval '2 years' where org_id = o and member_id = own;
  select * into s from public.pe_licences where org_id = o and member_id = 'mS2';
  out := out || format(E'\n%s explicitly set staff licence is left alone (%s, follows %s)', case when s.license_type = 'm1' and not s.follows_owner then 'PASS' else 'FAIL' end, s.license_type, s.follows_owner);
  select * into s from public.pe_licences where org_id = o and member_id = 'mS1';
  out := out || format(E'\n%s other staff still follow the owner (%s)', case when s.license_type = 'm12' and s.follows_owner then 'PASS' else 'FAIL' end, s.license_type);

  -- owner licence cleared -> following staff cleared
  update public.pe_licences set license_type = null, expires_at = null where org_id = o and member_id = own;
  select * into s from public.pe_licences where org_id = o and member_id = 'mS1';
  out := out || format(E'\n%s owner licence removed -> following staff unlicensed (%s)', case when s.license_type is null and not public.pe_member_licensed(o, 'mS1') then 'PASS' else 'FAIL' end, s.license_type);

  -- a business created by Proview (no self-signup trial) keeps per-person 3-day trials
  insert into public.pe_orgs(id, name, self_signup) values (o2, 'PE007 Proview-made', false);
  insert into public.pe_rows(org_id, coll, id, member_id, data) values (o2, 'members', 'mX', 'mX', '{"name":"Alex","role":"Member","email":"alex@test.invalid"}');
  select * into s from public.pe_licences where org_id = o2 and member_id = 'mX';
  out := out || format(E'\n%s Proview-made business unchanged: staff get own 3-day trial (%s, follows %s)', case when s.license_type = 'trial3' and not s.follows_owner then 'PASS' else 'FAIL' end, s.license_type, s.follows_owner);

  raise exception 'TEST RESULTS (rolled back):%', out;
end $T$;
