-- Test for 012 (licence per location, 10 staff included per licensed location, staff add-ons). One DO block that ends
-- with RAISE EXCEPTION, so everything is rolled back: the error message IS the PASS/FAIL report. Before 012 is applied,
-- build it with the migration in place of the --MIGRATION-- lines:  execute $mig$ <contents of 012_per_location_licence.sql> $mig$;
-- The hub token is swapped for a test token inside the transaction (rolled back with everything else).
do $t$
declare
  r text := '';
  u_master uuid := (select m.user_id from public.pe_masters m join auth.users u on u.id = m.user_id where u.email = 'altun@proviewtech.co.uk');
  u_own uuid := 'a0110000-0000-4000-8000-000000000001';
  u_ss uuid := 'a0110000-0000-4000-8000-000000000002';
  u_st uuid := 'a0110000-0000-4000-8000-000000000003';
  tok text := 'pl-test-token-' || gen_random_uuid();
  before_lic text; before_ok text; after_ok text; nlocs int;
  j jsonb; o text; o2 text; loc text; loc2 text; own text; ok boolean; msg text; n int; i int; st jsonb;
begin
  if u_master is null then raise exception 'no master'; end if;
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

  -- existing: licences, and who can work today
  select md5(coalesce(string_agg(l::text, '|' order by org_id, member_id), '')) into before_lic from public.pe_licences l;
  select md5(coalesce(string_agg(r0.org_id || r0.id || public.pe_member_licensed(r0.org_id, r0.id)::text, '|' order by r0.org_id, r0.id), '')) into before_ok
    from public.pe_rows r0 where r0.coll = 'members' and not r0.deleted;
  select count(*) into nlocs from public.pe_rows where coll = 'locations' and not deleted;

  --MIGRATION--

  update hub_private.config set token_sha256 = encode(extensions.digest(tok, 'sha256'), 'hex') where id = 1;

  -- ---------- 1. existing
  r := r || format(E'%s existing locations lifetime: %s of %s\n',
    case when (select count(*) from public.pe_location_licences where license_type = 'lifetime') = nlocs then 'PASS' else 'FAIL' end,
    (select count(*) from public.pe_location_licences where license_type = 'lifetime'), nlocs);
  select md5(coalesce(string_agg(r0.org_id || r0.id || public.pe_member_licensed(r0.org_id, r0.id)::text, '|' order by r0.org_id, r0.id), '')) into after_ok
    from public.pe_rows r0 where r0.coll = 'members' and not r0.deleted and r0.org_id in (select id from public.pe_orgs where name not like 'PE011%');
  r := r || format(E'%s existing staff: licensed exactly as before (nobody locked out); existing staff licences unchanged: %s\n',
    case when before_ok = after_ok and before_lic = (select md5(coalesce(string_agg(l::text, '|' order by org_id, member_id), '')) from public.pe_licences l) then 'PASS' else 'FAIL' end,
    before_lic = (select md5(coalesce(string_agg(l::text, '|' order by org_id, member_id), '')) from public.pe_licences l));

  -- ---------- 2. a new business (master's Add business): its location has no licence, the owner is locked
  perform pg_temp.as_(u_master, 'altun@proviewtech.co.uk');
  j := public.pe_add_business('PE011 Cafe', 'Olive Owner', 'pe011-owner@test.invalid', '', 'secret12');
  perform pg_temp.svc();
  o := j->>'org_id'; loc := j->>'location_id'; own := j->>'member_id'; u_own := (j->>'user_id')::uuid;
  r := r || format(E'%s new location (Add business) has no licence; owner not licensed (allowance %s)\n',
    case when not public.pe_location_licensed(o, loc) and not public.pe_member_licensed(o, own) and public.pe_staff_allowance(o) = 0 then 'PASS' else 'FAIL' end,
    public.pe_staff_allowance(o));
  perform pg_temp.as_(u_own, 'pe011-owner@test.invalid');
  select w.locked into ok from public.pe_whoami() w where w.org_id = o;
  st := public.pe_licence_status(o);
  perform pg_temp.svc();
  r := r || format(E'%s owner of an unlicensed business: whoami locked %s; licence status (while locked): location ok %s, allowance %s\n',
    case when ok and st->'locations'->0->>'ok' = 'false' and (st->>'allowance')::int = 0 and st->'staff' is not null then 'PASS' else 'FAIL' end,
    ok, st->'locations'->0->>'ok', st->>'allowance');

  -- the master's 3-day trial (011): the location gets the same trial, so a new staff member is covered by the package
  perform pg_temp.as_(u_master, 'altun@proviewtech.co.uk');
  j := public.pe_add_business('PE011 Trial', 'Tia Trial', 'pe011-trial@test.invalid', '', 'secret12');
  st := public.pe_master_trial(j->>'org_id');
  perform pg_temp.svc();
  insert into public.pe_rows (org_id, coll, id, member_id, data, deleted)
  values (j->>'org_id', 'members', 'mpe011tr', 'mpe011tr', '{"id":"mpe011tr","name":"Trial Staff","role":"Member","archived":false}', false);
  r := r || format(E'%s master''s 3-day trial: location trial3 to the same end, owner and a new staff member licensed\n',
    case when (st->>'applied')::boolean
          and (select license_type = 'trial3' and expires_at = (st->>'expires_at')::timestamptz from public.pe_location_licences where org_id = j->>'org_id' and location_id = j->>'location_id')
          and public.pe_member_licensed(j->>'org_id', j->>'member_id') and public.pe_member_licensed(j->>'org_id', 'mpe011tr') then 'PASS' else 'FAIL' end);

  -- self-signup
  insert into auth.users (id, email, aud, role, email_confirmed_at) values (u_ss, 'pe011-self@test.invalid', 'authenticated', 'authenticated', now());
  perform pg_temp.as_(u_ss, 'pe011-self@test.invalid');
  o2 := public.pe_start_trial('PE011 Self', 'PE011 Self Site', 'mpe011self', 'Self Owner');
  perform pg_temp.svc();
  r := r || format(E'%s self-signup: its location has no licence, owner not licensed\n',
    case when not exists (select 1 from public.pe_rows x where x.org_id = o2 and x.coll = 'locations' and public.pe_location_licensed(o2, x.id))
          and not public.pe_member_licensed(o2, 'mpe011self') then 'PASS' else 'FAIL' end);
  -- hub add_business
  j := public.hub_call(tok, 'add_business', jsonb_build_object('business', 'PE011 Hub', 'name', 'Hub Owner', 'email', 'pe011-hub@test.invalid', 'password', 'secret12'));
  r := r || format(E'%s hub add_business: its location has no licence\n',
    case when not public.pe_location_licensed(j->>'org_id', j->>'location_id') then 'PASS' else 'FAIL' end);

  -- ---------- 3. buy the location licence (hub set, loc/ unit, no kind): the owner is in, 10 staff included
  j := public.hub_call(tok, 'set', jsonb_build_object('unit', 'loc/' || o || '/' || loc, 'type', 'm12'));
  r := r || format(E'%s set loc/<org>/<location> (no kind) = location licence (%s, kind %s, id %s); owner now licensed by the package: %s\n',
    case when j->>'license_type' = 'm12' and j->>'kind' = 'location' and j->>'id' = 'loc/' || o || '/' || loc and public.pe_member_licensed(o, own) then 'PASS' else 'FAIL' end,
    j->>'license_type', j->>'kind', j->>'id', public.pe_member_licensed(o, own));

  -- 11 more staff, joined one day apart after the owner (12 people, 10 places)
  for i in 1..11 loop
    insert into public.pe_rows (org_id, coll, id, member_id, data, deleted)
    values (o, 'members', 'mpe011s' || lpad(i::text, 2, '0'), 'mpe011s' || lpad(i::text, 2, '0'),
            jsonb_build_object('id', 'mpe011s' || lpad(i::text, 2, '0'), 'name', 'Staff ' || i, 'role', 'Member', 'archived', false,
                               'joined', to_char(current_date + i, 'YYYY-MM-DD')), false);
  end loop;
  perform pg_temp.as_(u_own, 'pe011-owner@test.invalid');
  st := public.pe_licence_status(o);
  perform pg_temp.svc();
  r := r || format(E'%s package: 12 people, allowance %s, included %s, need an add-on %s (staff 10 and 11, the latest joined)\n',
    case when (st->>'allowance')::int = 10 and (st->>'included')::int = 10 and (st->>'counted')::int = 12 and (st->>'needs_addon')::int = 2
          and public.pe_member_licensed(o, 'mpe011s09') and not public.pe_member_licensed(o, 'mpe011s10') and not public.pe_member_licensed(o, 'mpe011s11') then 'PASS' else 'FAIL' end,
    st->>'allowance', st->>'included', st->>'needs_addon');

  -- a staff add-on for staff 11 (hub set without kind = staff licence, as before)
  j := public.hub_call(tok, 'set', jsonb_build_object('unit', o || '/mpe011s11', 'type', 'm12'));
  r := r || format(E'%s staff add-on (set without kind, kind %s): staff 11 covered, staff 10 still needs one\n',
    case when j->>'kind' = 'staff' and public.pe_member_licensed(o, 'mpe011s11') and not public.pe_member_licensed(o, 'mpe011s10') then 'PASS' else 'FAIL' end, j->>'kind');
  -- someone earlier leaves (archived): staff 10 moves into the package
  update public.pe_rows set data = data || '{"archived": true}' where org_id = o and coll = 'members' and id = 'mpe011s02';
  r := r || format(E'%s an earlier person leaves: staff 10 covered automatically; the leaver doesn''t count\n',
    case when public.pe_member_licensed(o, 'mpe011s10') and (select count(*) from public.pe_staff_coverage(o)) = 11 then 'PASS' else 'FAIL' end);
  update public.pe_rows set data = data || '{"archived": false}' where org_id = o and coll = 'members' and id = 'mpe011s02';

  -- ---------- 4. clock-in needs the location's licence, and the person covered
  insert into public.pe_rows (org_id, coll, id, member_id, data, deleted)
  values (o, 'locations', 'lpe011two', null, '{"id":"lpe011two","name":"Second Shop","archived":false}', false);
  loc2 := 'lpe011two';
  ok := true; msg := null;
  begin insert into public.pe_rows (org_id, coll, id, member_id, data) values (o, 'entries', 'epe011a', 'mpe011s01', jsonb_build_object('member', 'mpe011s01', 'location', loc, 'in', now()::text));
  exception when others then ok := false; msg := sqlerrm; end;
  r := r || format(E'%s clock-in at the licensed location, covered person: allowed %s\n', case when ok then 'PASS' else 'FAIL' end, coalesce(msg, ''));
  ok := true; msg := null;
  begin insert into public.pe_rows (org_id, coll, id, member_id, data) values (o, 'entries', 'epe011b', 'mpe011s01', jsonb_build_object('member', 'mpe011s01', 'location', loc2, 'in', now()::text));
  exception when others then ok := false; msg := sqlerrm; end;
  r := r || format(E'%s a new location starts unlicensed; clock-in there refused (%s)\n',
    case when not ok and msg like 'Second Shop has no Proview Employee licence yet%' then 'PASS' else 'FAIL' end, coalesce(msg, 'allowed'));
  ok := true; msg := null;
  begin insert into public.pe_rows (org_id, coll, id, member_id, data) values (o, 'shifts', 'spe011b', 'mpe011s01', jsonb_build_object('member', 'mpe011s01', 'location', loc2, 'date', current_date::text));
  exception when others then ok := false; msg := sqlerrm; end;
  r := r || format(E'%s rota shift at the unlicensed location refused\n', case when not ok and msg like 'Second Shop has no%' then 'PASS' else 'FAIL' end);
  ok := true; msg := null;
  begin insert into public.pe_rows (org_id, coll, id, member_id, data) values (o, 'entries', 'epe011c', 'mpe011s10', jsonb_build_object('member', 'mpe011s10', 'location', loc, 'in', now()::text));
  exception when others then ok := false; msg := sqlerrm; end;
  r := r || format(E'%s staff over the allowance without an add-on: clock-in refused (%s)\n',
    case when not ok and msg like 'This person isn''t included%add-on%' then 'PASS' else 'FAIL' end, coalesce(msg, 'allowed'));
  -- the location licence ends (past grace): clocking out of an open entry still works, new clock-ins are refused
  perform public.hub_call(tok, 'set', jsonb_build_object('unit', o || '/' || loc, 'kind', 'location', 'type', 'custom', 'expires', (now() - interval '10 days')::text));
  ok := true; msg := null;
  begin insert into public.pe_rows (org_id, coll, id, member_id, data) values (o, 'entries', 'epe011a', 'mpe011s01', jsonb_build_object('member', 'mpe011s01', 'location', loc, 'in', now()::text, 'out', now()::text))
        on conflict (org_id, coll, id) do update set data = excluded.data;
  exception when others then ok := false; msg := sqlerrm; end;
  r := r || format(E'%s kind=location without the prefix works; location expired: clocking out of an open entry still works %s\n', case when ok then 'PASS' else 'FAIL' end, coalesce(msg, ''));
  ok := true; msg := null;
  begin insert into public.pe_rows (org_id, coll, id, member_id, data) values (o, 'entries', 'epe011d', 'mpe011s01', jsonb_build_object('member', 'mpe011s01', 'location', loc, 'in', now()::text));
  exception when others then ok := false; msg := sqlerrm; end;
  r := r || format(E'%s location expired: new clock-in refused; nobody in the package any more (allowance %s); add-on holder still licensed %s\n',
    case when not ok and public.pe_staff_allowance(o) = 0 and not public.pe_member_licensed(o, own) and public.pe_member_licensed(o, 'mpe011s11') then 'PASS' else 'FAIL' end,
    public.pe_staff_allowance(o), public.pe_member_licensed(o, 'mpe011s11'));
  j := public.hub_call(tok, 'set', jsonb_build_object('unit', 'loc/' || o || '/' || loc, 'type', 'm1', 'extend', true));
  r := r || format(E'%s extend after the end starts from now (%s)\n',
    case when (j->>'expires_at')::timestamptz between now() + interval '27 days' and now() + interval '32 days' then 'PASS' else 'FAIL' end, j->>'expires_at');

  -- ---------- 5. hub list, wrong token, non-master
  j := public.hub_call(tok, 'list', '{}');
  r := r || format(E'%s list: location units %s (= locations %s) with kind location, staff units with kind staff + covered/needs_addon, every unit has a kind\n',
    case when (select count(*) from jsonb_array_elements(j->'units') u where u->>'kind' = 'location') = (select count(*) from public.pe_rows where coll = 'locations' and not deleted)
          and exists (select 1 from jsonb_array_elements(j->'units') u where u->>'id' = 'loc/' || o || '/' || loc and u->>'kind' = 'location' and u->>'account_id' = o and u->>'license_type' = 'm1')
          and exists (select 1 from jsonb_array_elements(j->'units') u where u->>'id' = 'loc/' || o || '/' || loc2 and u->>'license_type' is null)
          and exists (select 1 from jsonb_array_elements(j->'units') u where u->>'id' = o || '/mpe011s10' and u->>'kind' = 'staff' and (u->>'needs_addon')::boolean)
          and exists (select 1 from jsonb_array_elements(j->'units') u where u->>'id' = o || '/mpe011s11' and u->>'kind' = 'staff' and (u->>'covered')::boolean and not (u->>'package')::boolean)
          and exists (select 1 from jsonb_array_elements(j->'units') u where u->>'id' = o || '/' || own and (u->>'package')::boolean)
          and not exists (select 1 from jsonb_array_elements(j->'units') u where u->>'kind' is null) then 'PASS' else 'FAIL' end,
    (select count(*) from jsonb_array_elements(j->'units') u where u->>'kind' = 'location'), (select count(*) from public.pe_rows where coll = 'locations' and not deleted));
  ok := true; begin perform public.hub_call('wrong', 'list', '{}'); exception when others then ok := false; msg := sqlerrm; end;
  r := r || format(E'%s list with a wrong token refused (%s)\n', case when not ok and msg = 'not authorised' then 'PASS' else 'FAIL' end, msg);
  ok := true; begin perform public.hub_call('wrong', 'set', jsonb_build_object('unit', 'loc/' || o || '/' || loc2, 'type', 'lifetime')); exception when others then ok := false; msg := sqlerrm; end;
  r := r || format(E'%s set location with a wrong token refused; still unlicensed %s\n',
    case when not ok and msg = 'not authorised' and not public.pe_location_licensed(o, loc2) then 'PASS' else 'FAIL' end, not public.pe_location_licensed(o, loc2));
  ok := true; begin perform public.hub_call(tok, 'set', jsonb_build_object('unit', 'loc/' || o || '/nope', 'type', 'm12')); exception when others then ok := false; msg := sqlerrm; end;
  r := r || format(E'%s set an unknown location refused (%s)\n', case when not ok and msg = 'Location not found' then 'PASS' else 'FAIL' end, msg);
  perform pg_temp.as_(u_own, 'pe011-owner@test.invalid');
  ok := true; msg := null;
  begin insert into public.pe_location_licences (org_id, location_id, license_type) values (o, loc2, 'lifetime'); exception when others then ok := false; msg := sqlerrm; end;
  if ok then ok := true; end if;
  begin update public.pe_location_licences set license_type = 'lifetime' where org_id = o; get diagnostics n = row_count; exception when others then n := -1; end;
  perform pg_temp.svc();
  r := r || format(E'%s owner (non-master) can''t set a location licence (insert: %s; update rows: %s)\n',
    case when not ok and n <= 0 and not public.pe_location_licensed(o, loc2) then 'PASS' else 'FAIL' end, coalesce(msg, 'allowed'), n);
  perform pg_temp.as_(u_master, 'altun@proviewtech.co.uk');
  ok := true; begin insert into public.pe_location_licences (org_id, location_id, license_type) values (o, loc2, 'lifetime'); exception when others then ok := false; end;
  j := public.pe_master_overview();
  perform pg_temp.svc();
  r := r || format(E'%s the master''s app can''t set it directly either; master overview has locations, allowance and coverage\n',
    case when not ok and exists (select 1 from jsonb_array_elements(j) b where b->>'id' = o and jsonb_array_length(b->'locations') = 2
                                    and (b->>'allowance')::int = 10 and exists (select 1 from jsonb_array_elements(b->'staff') s where s->>'member_id' = 'mpe011s10' and not (s->>'covered')::boolean)) then 'PASS' else 'FAIL' end);
  -- a staff member (not owner/admin) sees their own coverage, not the staff list
  insert into auth.users (id, email, aud, role, email_confirmed_at) values (u_st, 'pe011-staff@test.invalid', 'authenticated', 'authenticated', now());
  insert into public.pe_people (org_id, user_id, member_id, role, email) values (o, u_st, 'mpe011s03', 'Member', 'pe011-staff@test.invalid');
  perform pg_temp.as_(u_st, 'pe011-staff@test.invalid');
  st := public.pe_licence_status(o);
  ok := true; begin perform public.pe_licence_status(o2); exception when others then ok := false; end;
  perform pg_temp.svc();
  r := r || format(E'%s staff member: own coverage only (me %s, staff list hidden %s); another business refused %s\n',
    case when st->'me'->>'member_id' = 'mpe011s03' and st->'staff' = 'null'::jsonb and not ok then 'PASS' else 'FAIL' end,
    st->'me'->>'covered', st->'staff' = 'null'::jsonb, not ok);

  -- ---------- 6. prices per kind
  j := public.hub_plans(tok, '{"m12":{"label":"12 months","amount":5000,"currency":"gbp","link":"https://buy.stripe.com/x","ref":"pve"}}');
  r := r || format(E'%s hub_plans old flat form = staff add-on prices (%s)\n',
    case when (select plans from hub_private.config) -> 'staff' ? 'm12' and (select plans from hub_private.config) -> 'location' = '{}'::jsonb then 'PASS' else 'FAIL' end, j);
  j := public.hub_plans(tok, '{"staff":{"m12":{"label":"12 months","amount":500,"currency":"gbp","link":"https://buy.stripe.com/staff","ref":"pve"}},"location":{"m12":{"label":"12 months","amount":9000,"currency":"gbp","link":"https://buy.stripe.com/loc","ref":"pve"}}}');
  perform pg_temp.as_(u_own, 'pe011-owner@test.invalid');
  j := jsonb_build_object('flat', public.licence_buy_plans(), 'kinds', public.licence_buy_plans_by_kind());
  perform pg_temp.svc();
  r := r || format(E'%s hub_plans per-kind; licence_buy_plans = staff prices, by_kind has both\n',
    case when j->'flat'->'m12'->>'link' = 'https://buy.stripe.com/staff' and not (j->'flat' ? 'location')
          and j->'kinds'->'location'->'m12'->>'link' = 'https://buy.stripe.com/loc' then 'PASS' else 'FAIL' end);
  ok := true; begin perform public.hub_plans('wrong', '{}'); exception when others then ok := false; end;
  r := r || format(E'%s hub_plans with a wrong token refused\n', case when not ok then 'PASS' else 'FAIL' end);

  -- ---------- 7. running the migration again changes nothing
  --MIGRATION--
  r := r || format(E'%s second run: existing still lifetime, new location still unlicensed, hub list still works\n',
    case when (select count(*) from public.pe_location_licences where license_type = 'lifetime') = nlocs
          and not public.pe_location_licensed(o, loc2)
          and jsonb_array_length(public.hub_call(tok, 'list', '{}')->'units') > 0 then 'PASS' else 'FAIL' end);

  raise exception E'ROLLED BACK. Results:\n%', r;
end $t$;
