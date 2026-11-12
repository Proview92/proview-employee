-- Tests for 014_locations_link.sql (hub_call 'link' / 'unlink'). One DO block that always fails at the end (the results
-- come back in the error message), so every test row is rolled back. Before 014 is applied, replace the --MIGRATION--
-- line with: execute $mig$ <contents of 014_locations_link.sql> $mig$;
do $T$
declare
  out text := '';
  tok text := 'll-test-token-' || gen_random_uuid();
  um uuid := gen_random_uuid(); u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); u3 uuid := gen_random_uuid();
  e1 text := 'll-own-' || substr(md5(random()::text), 1, 6) || '@example.com';
  e2 text := 'll-own-b-' || substr(md5(random()::text), 1, 6) || '@example.com';
  e3 text := 'll-staff-b-' || substr(md5(random()::text), 1, 6) || '@example.com';
  oa text; ob text; n_before int; n_after int; j jsonb; j2 jsonb; lst jsonb; msg text; nid text; ok boolean; bl text;
begin
  update hub_private.config set token_sha256 = encode(extensions.digest(tok, 'sha256'), 'hex') where id = 1;
  n_before := jsonb_array_length(public.hub_call(tok, 'list', '{}')->'units');

  --MIGRATION--

  n_after := jsonb_array_length(public.hub_call(tok, 'list', '{}')->'units');
  out := out || format(E'%s list unchanged after the migration (%s units)\n', case when n_before = n_after then 'PASS' else 'FAIL' end, n_after);
  out := out || format(E'%s old hub_call kept as hub_private.hub_call_pre_link; link functions not callable by the API\n',
    case when to_regprocedure('hub_private.hub_call_pre_link(text,text,jsonb)') is not null
          and not has_function_privilege('anon', 'hub_private.hub_call_pre_link(text,text,jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'hub_private.pe_link_orgs(text,text)', 'execute') then 'PASS' else 'FAIL' end);
  begin perform public.hub_call('wrong', 'link', '{}'); ok := false; exception when others then ok := sqlerrm = 'not authorised'; end;
  out := out || format(E'%s link with a wrong token: refused\n', case when ok then 'PASS' else 'FAIL' end);

  -- test data, written as the master: A = 'LL Cafe Alpha' (location l1, owner e1), B = 'LL Cafe Beta' (location l1 too,
  -- owner e2, staff e3, and e1 again as a Member)
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at) values
    (um, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'll-master-' || um || '@example.com', now(), now(), now()),
    (u1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e1, now(), now(), now()),
    (u2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e2, now(), now(), now()),
    (u3, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e3, now(), now(), now());
  delete from public.pe_masters;   -- (rolled back) the test master is the hub's master
  insert into public.pe_masters (user_id) values (um);
  perform set_config('request.jwt.claims', json_build_object('sub', um, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', um::text, true);
  insert into public.pe_orgs (name, contact_email, self_signup) values ('LL Cafe Alpha', e1, false) returning id into oa;
  insert into public.pe_orgs (name, contact_email, self_signup) values ('LL Cafe Beta', e2, false) returning id into ob;
  insert into public.pe_rows (org_id, coll, id, data) values
    (oa, 'org', 'org', '{"name":"LL Cafe Alpha"}'), (ob, 'org', 'org', '{"name":"LL Cafe Beta"}'),
    (oa, 'locations', 'l1', '{"id":"l1","name":"LL Cafe Alpha","archived":false}'),
    (ob, 'locations', 'l1', '{"id":"l1","name":"LL Cafe Beta","archived":false}'),
    (ob, 'schedules', 's1', '{"id":"s1","name":"Beta week","locations":["l1"]}');
  insert into public.pe_location_licences (org_id, location_id, license_type, starts_at, expires_at) values (ob, 'l1', 'm12', now(), now() + interval '1 year');
  insert into public.pe_rows (org_id, coll, id, member_id, data) values
    (oa, 'members', 'ma1', 'ma1', jsonb_build_object('id', 'ma1', 'name', 'Al Owner', 'role', 'Owner', 'email', e1)),
    (ob, 'members', 'mb2', 'mb2', jsonb_build_object('id', 'mb2', 'name', 'Bea Owner', 'role', 'Owner', 'email', e2)),
    (ob, 'members', 'mb3', 'mb3', jsonb_build_object('id', 'mb3', 'name', 'Cy Staff', 'role', 'Member', 'email', e3, 'sites', '[]'::jsonb)),
    (ob, 'members', 'mb1', 'mb1', jsonb_build_object('id', 'mb1', 'name', 'Al Owner', 'role', 'Member', 'email', e1)),
    (ob, 'entries', 'eb1', 'mb3', '{"id":"eb1","member":"mb3","location":"l1","in":1}'),
    (ob, 'entries', 'eb2', 'mb1', '{"id":"eb2","member":"mb1","location":"l1","in":2}');
  insert into public.pe_people (org_id, user_id, member_id, role, email) values
    (oa, u1, 'ma1', 'Owner', e1), (ob, u2, 'mb2', 'Owner', e2), (ob, u3, 'mb3', 'Member', e3), (ob, u1, 'mb1', 'Member', e1);
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true);

  -- adding / deleting a location from the app is refused, the master included
  perform set_config('request.jwt.claims', json_build_object('sub', um, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', um::text, true);
  begin insert into public.pe_rows (org_id, coll, id, data) values (oa, 'locations', 'l2', '{"id":"l2","name":"Second"}'); msg := null; exception when others then msg := sqlerrm; end;
  out := out || format(E'%s adding a second location refused, master included (%s)\n', case when msg like 'Locations can''t be added here%' then 'PASS' else 'FAIL' end, msg);
  begin update public.pe_rows set deleted = true where org_id = oa and coll = 'locations' and id = 'l1'; msg := null; exception when others then msg := sqlerrm; end;
  out := out || format(E'%s deleting a location refused (%s)\n', case when msg like 'Locations can''t be deleted here%' then 'PASS' else 'FAIL' end, msg);
  begin update public.pe_rows set data = data || '{"archived":true}' where org_id = oa and coll = 'locations' and id = 'l1'; msg := null; exception when others then msg := sqlerrm; end;
  out := out || format(E'%s archiving a location refused (%s)\n', case when msg like 'Locations can''t be deleted here%' then 'PASS' else 'FAIL' end, msg);
  update public.pe_rows set data = data || '{"address":"1 High St"}' where org_id = oa and coll = 'locations' and id = 'l1';
  out := out || format(E'%s location settings still editable\n',
    case when (select data->>'address' from public.pe_rows where org_id = oa and coll = 'locations' and id = 'l1') = '1 High St' then 'PASS' else 'FAIL' end);
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true);

  -- 1. link B into A
  j := public.hub_call(tok, 'link', jsonb_build_object('into', oa, 'from', ob));
  select x.e->>'to' into bl from jsonb_array_elements(j->'renamed_units') x(e) where x.e->>'kind' = 'location';
  bl := substr(bl, length('loc/' || oa || '/') + 1);
  out := out || format(E'%s link answer: ok, account A, B''s location renamed (l1 is taken) and listed (%s)\n',
    case when (j->>'ok')::boolean and j->>'account' = oa and bl like 'l1\_%' and j->'moved_sites' = jsonb_build_array('loc/' || oa || '/' || bl)
         then 'PASS' else 'FAIL' end, j);
  out := out || format(E'%s B is gone; A has both locations; B''s licence moved with its location\n',
    case when not exists (select 1 from public.pe_orgs where id = ob)
          and (select count(*) from public.pe_rows where org_id = oa and coll = 'locations' and not deleted) = 2
          and (select license_type from public.pe_location_licences where org_id = oa and location_id = bl) = 'm12' then 'PASS' else 'FAIL' end);
  out := out || format(E'%s references rewritten: entries and schedule point at B''s renamed location\n',
    case when (select data->>'location' from public.pe_rows where org_id = oa and coll = 'entries' and id = 'eb1') = bl
          and (select data->'locations' from public.pe_rows where org_id = oa and coll = 'schedules' and id = 's1') = jsonb_build_array(bl) then 'PASS' else 'FAIL' end);
  out := out || format(E'%s same person (e1) is one member (A''s, still Owner); their B entry now theirs in A\n',
    case when not exists (select 1 from public.pe_rows where org_id = oa and coll = 'members' and id = 'mb1')
          and (select data->>'role' from public.pe_rows where org_id = oa and coll = 'members' and id = 'ma1') = 'Owner'
          and (select member_id = 'ma1' and data->>'member' = 'ma1' from public.pe_rows where org_id = oa and coll = 'entries' and id = 'eb2')
          and (select count(*) from public.pe_people where user_id = u1) = 1 then 'PASS' else 'FAIL' end);
  out := out || format(E'%s B''s owner joined A as Owner (all locations); B''s staff keeps only B''s location\n',
    case when (select role from public.pe_people where org_id = oa and user_id = u2) = 'Owner'
          and (select data->'sites' from public.pe_rows where org_id = oa and coll = 'members' and id = 'mb3') = jsonb_build_array(bl)
          and (select site_ids from public.pe_people where org_id = oa and user_id = u3) = array[bl] then 'PASS' else 'FAIL' end);
  out := out || format(E'%s renamed_units lists B''s staff units too\n',
    case when exists (select 1 from jsonb_array_elements(j->'renamed_units') x(e) where x.e->>'kind' = 'staff' and x.e->>'from' = ob || '/mb3' and x.e->>'to' = oa || '/mb3')
          and exists (select 1 from jsonb_array_elements(j->'renamed_units') x(e) where x.e->>'kind' = 'staff' and x.e->>'from' = ob || '/mb1' and x.e->>'to' = oa || '/ma1')
         then 'PASS' else 'FAIL' end);
  lst := public.hub_call(tok, 'list', '{}');
  out := out || format(E'%s list: both location units under A, B''s account gone\n',
    case when (select count(*) from jsonb_array_elements(lst->'units') u where u->>'kind' = 'location' and u->>'account_id' = oa) = 2
          and not exists (select 1 from jsonb_array_elements(lst->'accounts') a where a->>'id' = ob) then 'PASS' else 'FAIL' end);
  out := out || format(E'%s request claims put back after the call\n',
    case when coalesce(current_setting('request.jwt.claim.sub', true), '') = '' then 'PASS' else 'FAIL' end);

  -- 2. idempotent; refusals
  j2 := public.hub_call(tok, 'link', jsonb_build_object('into', oa, 'from', ob));
  out := out || format(E'%s link again: ok, already, same answer (%s)\n',
    case when (j2->>'already')::boolean and j2->'moved_sites' = j->'moved_sites' and j2->'renamed_units' = j->'renamed_units' then 'PASS' else 'FAIL' end, j2->'moved_sites');
  begin perform public.hub_call(tok, 'link', jsonb_build_object('into', oa, 'from', oa)); msg := null; exception when others then msg := sqlerrm; end;
  out := out || format(E'%s link to itself refused (%s)\n', case when msg like '%itself%' then 'PASS' else 'FAIL' end, msg);
  begin perform public.hub_call(tok, 'link', jsonb_build_object('into', 'nope', 'from', oa)); msg := null; exception when others then msg := sqlerrm; end;
  out := out || format(E'%s link into a missing account refused (%s)\n', case when msg like 'Account not found:%' then 'PASS' else 'FAIL' end, msg);

  -- 3. unlink B's location again
  j := public.hub_call(tok, 'unlink', jsonb_build_object('account', oa, 'site', 'loc/' || oa || '/' || bl));
  nid := j->>'account';
  out := out || format(E'%s unlink answer: ok, new account, site loc/<new>/<loc>, renamed_units (%s)\n',
    case when (j->>'ok')::boolean and nid is not null and nid <> oa and j->>'site' = 'loc/' || nid || '/' || bl
          and j->'renamed_units' = jsonb_build_array(jsonb_build_object('kind', 'location', 'from', 'loc/' || oa || '/' || bl, 'to', 'loc/' || nid || '/' || bl))
         then 'PASS' else 'FAIL' end, j);
  out := out || format(E'%s new business named after the location, holding it, its licence and its time entries\n',
    case when (select name from public.pe_orgs where id = nid) = 'LL Cafe Beta'
          and (select array_agg(id) from public.pe_rows where org_id = nid and coll = 'locations') = array[bl]
          and (select license_type from public.pe_location_licences where org_id = nid and location_id = bl) = 'm12'
          and (select count(*) from public.pe_rows where org_id = nid and coll = 'entries') = 2 then 'PASS' else 'FAIL' end);
  out := out || format(E'%s people copied with their logins (owners e1, e2; staff e3); settings copied\n',
    case when (select count(*) from public.pe_people where org_id = nid and user_id in (u1, u2, u3)) = 3
          and exists (select 1 from public.pe_rows where org_id = nid and coll = 'org' and data->>'name' = 'LL Cafe Beta') then 'PASS' else 'FAIL' end);
  out := out || format(E'%s in A: the staff member who only had that location is archived; owners stay\n',
    case when (select (data->>'archived')::boolean from public.pe_rows where org_id = oa and coll = 'members' and id = 'mb3')
          and not exists (select 1 from public.pe_people where org_id = oa and user_id = u3)
          and (select count(*) from public.pe_people where org_id = oa and user_id in (u1, u2)) = 2 then 'PASS' else 'FAIL' end);
  j2 := public.hub_call(tok, 'unlink', jsonb_build_object('account', oa, 'site', bl));
  out := out || format(E'%s unlink again (bare location id): ok, already, same new account (%s)\n', case when (j2->>'already')::boolean and j2->>'account' = nid then 'PASS' else 'FAIL' end, j2);
  begin perform public.hub_call(tok, 'unlink', jsonb_build_object('account', oa, 'site', 'loc/' || oa || '/l1')); msg := null; exception when others then msg := sqlerrm; end;
  out := out || format(E'%s unlink of the only location refused (%s)\n', case when msg like '%only that one location%' then 'PASS' else 'FAIL' end, msg);
  begin perform public.hub_call(tok, 'unlink', jsonb_build_object('account', oa, 'site', 'nope')); msg := null; exception when others then msg := sqlerrm; end;
  out := out || format(E'%s unlink of a missing location refused (%s)\n', case when msg like 'Location not found:%' then 'PASS' else 'FAIL' end, msg);

  raise exception E'014 test (rolled back):\n%', out;
end $T$;
