-- Tests for 008_add_business.sql. Run together with the migration as ONE query: everything is one
-- transaction that always fails at the end (results in the error message), so nothing is kept.
do $T$
declare
  out text := '';
  u_master uuid := (select m.user_id from public.pe_masters m join auth.users u on u.id = m.user_id where u.email = 'altun@proviewtech.co.uk');
  u_other uuid := gen_random_uuid(); u_old uuid := gen_random_uuid();
  r jsonb; e text; pw_before text; pw_after text; n int; nb int; w record; o text;
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

  insert into auth.users (id, email, encrypted_password, aud, role, email_confirmed_at) values
    (u_other, 'pe008-other@test.invalid', extensions.crypt('otherpass', extensions.gen_salt('bf', 4)), 'authenticated', 'authenticated', now()),
    (u_old,   'pe008-old@test.invalid',   extensions.crypt('oldpass1',  extensions.gen_salt('bf', 4)), 'authenticated', 'authenticated', now());
  select encrypted_password into pw_before from auth.users where id = u_old;

  -- 1. master, new email
  perform pg_temp.as_(u_master, 'altun@proviewtech.co.uk');
  r := public.pe_add_business('PE008 Test Cafe', 'Sam Taylor', ' PE008-New@Test.Invalid ', '07700 900123', 'secret12');
  perform pg_temp.svc();
  o := r->>'org_id';
  out := out || format(E'\n%s master adds (new email): existing=%s', case when not (r->>'existing')::boolean then 'PASS' else 'FAIL' end, r->>'existing');
  select count(*) into n from public.pe_orgs where id = o and name = 'PE008 Test Cafe' and not self_signup and contact_email = 'pe008-new@test.invalid';
  out := out || format(E'\n%s business row (added by Proview) (%s)', case when n = 1 then 'PASS' else 'FAIL' end, n);
  select count(*) into n from public.pe_rows where org_id = o and coll = 'locations' and not deleted and data->>'name' = 'PE008 Test Cafe';
  out := out || format(E'\n%s one location with the same name (%s)', case when n = 1 then 'PASS' else 'FAIL' end, n);
  select count(*) into n from auth.users u where u.id = (r->>'user_id')::uuid and u.email = 'pe008-new@test.invalid'
     and u.email_confirmed_at is not null and u.encrypted_password = extensions.crypt('secret12', u.encrypted_password)
     and u.raw_user_meta_data->>'name' = 'Sam Taylor' and u.raw_user_meta_data->>'mobile' = '07700 900123'
     and exists (select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email');
  out := out || format(E'\n%s login ready: confirmed, password set, name + mobile, email identity (%s)', case when n = 1 then 'PASS' else 'FAIL' end, n);
  select count(*) into n from public.pe_rows where org_id = o and coll = 'members' and id = r->>'member_id' and data->>'role' = 'Owner' and data->>'name' = 'Sam Taylor' and data->>'phone' = '07700 900123';
  out := out || format(E'\n%s member record: Owner, name, phone (%s)', case when n = 1 then 'PASS' else 'FAIL' end, n);
  select count(*) into n from public.pe_people where org_id = o and user_id = (r->>'user_id')::uuid and role = 'Owner' and member_id = r->>'member_id';
  out := out || format(E'\n%s pe_people Owner (%s)', case when n = 1 then 'PASS' else 'FAIL' end, n);
  select count(*) into n from public.pe_licences where org_id = o and member_id = r->>'member_id' and license_type = 'trial3' and expires_at > now() + interval '71 hours' and not follows_owner;
  out := out || format(E'\n%s owner on the usual 3-day trial3 licence (%s)', case when n = 1 then 'PASS' else 'FAIL' end, n);
  out := out || format(E'\n%s not a self-signup trial business: staff keep their own trial (pe_trial_owner null, no pe_trial_emails row)',
    case when public.pe_trial_owner(o) is null and not exists (select 1 from public.pe_trial_emails where org_id = o or email = 'pe008-new@test.invalid') then 'PASS' else 'FAIL' end);
  perform pg_temp.as_((r->>'user_id')::uuid, 'pe008-new@test.invalid');
  select count(*) into n from public.pe_whoami() x;
  select * into w from public.pe_whoami() x limit 1;
  perform pg_temp.svc();
  out := out || format(E'\n%s new owner whoami: one business, Owner, not locked, not master (%s %s %s %s)',
    case when n = 1 and w.org_id = o and w.role = 'Owner' and not w.locked and not w.is_master then 'PASS' else 'FAIL' end, n, w.role, w.locked, w.is_master);
  -- a staff member added later by this owner gets their own trial (rules unchanged)
  perform pg_temp.as_((r->>'user_id')::uuid, 'pe008-new@test.invalid');
  insert into public.pe_rows (org_id, coll, id, member_id, data) values (o, 'members', 'mpe008staff', 'mpe008staff',
    jsonb_build_object('id', 'mpe008staff', 'name', 'Staff One', 'role', 'Member', 'email', 'pe008-staff@test.invalid', 'archived', false));
  perform pg_temp.svc();
  select count(*) into n from public.pe_licences where org_id = o and member_id = 'mpe008staff' and license_type = 'trial3' and not follows_owner;
  out := out || format(E'\n%s staff added by the new owner get the usual trial3 (%s)', case when n = 1 then 'PASS' else 'FAIL' end, n);

  -- 2. non-master refused
  select count(*) into nb from public.pe_orgs;
  perform pg_temp.as_(u_other, 'pe008-other@test.invalid');
  begin r := public.pe_add_business('PE008 Sneaky', 'Eve Other', 'pe008-eve@test.invalid', null, 'secret12'); e := 'no error';
  exception when others then e := sqlerrm; end;
  perform pg_temp.svc();
  select count(*) into n from public.pe_orgs;
  out := out || format(E'\n%s non-master refused (%s), businesses %s -> %s', case when e = 'Only the master admin can add businesses.' and n = nb then 'PASS' else 'FAIL' end, e, nb, n);
  begin
    execute 'set local role anon';
    perform public.pe_add_business('PE008 Anon', 'An On', 'pe008-anon@test.invalid', null, 'secret12'); e := 'no error';
  exception when others then e := sqlerrm; end;
  perform pg_temp.svc();
  out := out || format(E'\n%s anon refused (%s)', case when e like 'permission denied%' then 'PASS' else 'FAIL' end, e);

  -- 3. existing login keeps its password
  perform pg_temp.as_(u_master, 'altun@proviewtech.co.uk');
  r := public.pe_add_business('PE008 Old Hands Ltd', 'Old Hand', 'PE008-old@test.invalid', null, 'NEWpass99');
  perform pg_temp.svc();
  select encrypted_password into pw_after from auth.users where id = u_old;
  out := out || format(E'\n%s existing login: existing=%s, same user=%s, password unchanged=%s',
    case when (r->>'existing')::boolean and (r->>'user_id')::uuid = u_old and pw_after = pw_before then 'PASS' else 'FAIL' end,
    r->>'existing', (r->>'user_id')::uuid = u_old, pw_after = pw_before);
  select count(*) into n from public.pe_people where org_id = r->>'org_id' and user_id = u_old and role = 'Owner';
  out := out || format(E'\n%s existing login made Owner (%s)', case when n = 1 then 'PASS' else 'FAIL' end, n);
  select count(*) into n from auth.users where lower(email) = 'pe008-old@test.invalid';
  out := out || format(E'\n%s no second login made (%s)', case when n = 1 then 'PASS' else 'FAIL' end, n);

  -- 4. bad input refused, nothing left behind
  select count(*) into nb from public.pe_orgs;
  perform pg_temp.as_(u_master, 'altun@proviewtech.co.uk');
  begin r := public.pe_add_business('PE008 Bad Email', 'Bad Email', 'not-an-email', null, 'secret12'); e := 'no error';
  exception when others then e := sqlerrm; end;
  out := out || format(E'\n%s bad email refused (%s)', case when e = 'Enter a valid email address.' then 'PASS' else 'FAIL' end, e);
  begin r := public.pe_add_business('PE008 Short Pass', 'Short Pass', 'pe008-short@test.invalid', null, '12345'); e := 'no error';
  exception when others then e := sqlerrm; end;
  out := out || format(E'\n%s short password refused (%s)', case when e = 'The password needs at least 6 characters.' then 'PASS' else 'FAIL' end, e);
  begin r := public.pe_add_business('X', 'Some One', 'pe008-x@test.invalid', null, 'secret12'); e := 'no error';
  exception when others then e := sqlerrm; end;
  out := out || format(E'\n%s 1-letter business refused (%s)', case when e = 'Enter the business name.' then 'PASS' else 'FAIL' end, e);
  begin r := public.pe_add_business('PE008 No Name', 'S', 'pe008-x@test.invalid', null, 'secret12'); e := 'no error';
  exception when others then e := sqlerrm; end;
  out := out || format(E'\n%s 1-letter owner name refused (%s)', case when e = 'Enter the owner''s name.' then 'PASS' else 'FAIL' end, e);
  perform pg_temp.svc();
  select count(*) into n from public.pe_orgs;
  out := out || format(E'\n%s no business left behind after refusals (%s -> %s)', case when n = nb then 'PASS' else 'FAIL' end, nb, n);
  select count(*) into n from auth.users where email in ('pe008-short@test.invalid', 'pe008-x@test.invalid');
  out := out || format(E'\n%s no login left behind after refusals (%s)', case when n = 0 then 'PASS' else 'FAIL' end, n);

  raise exception 'TEST RESULTS (rolled back):%', out;
end $T$;
