-- Live check of 013 (hub_call 'trial' for the licence portal's New customer). One DO block that ends with RAISE EXCEPTION,
-- so everything is rolled back: the error message IS the PASS/FAIL report. Before 013 is applied, replace the
-- --MIGRATION-- lines with:   execute $mig$ <contents of 013_hub_trial.sql> $mig$;
-- The hub token is swapped for a test token inside the transaction (rolled back with everything else).
do $t$
declare
  r text := '';
  tok text := 'nc-test-token-' || gen_random_uuid();
  em text := 'nc-trial-test-' || substr(md5(random()::text), 1, 8) || '@example.com';
  n_before int; n_after int; j jsonb; t jsonb; t2 jsonb; org text; ok boolean; lst jsonb; own text; e timestamptz;
  lic public.pe_licences; loc public.pe_location_licences; ou uuid;
begin
  update hub_private.config set token_sha256 = encode(extensions.digest(tok, 'sha256'), 'hex') where id = 1;
  n_before := jsonb_array_length(public.hub_call(tok, 'list', '{}')->'units');

  --MIGRATION--

  -- 1. every other action still goes to the old hub_call
  n_after := jsonb_array_length(public.hub_call(tok, 'list', '{}')->'units');
  r := r || format(E'%s list unchanged after the migration (%s units)\n', case when n_before = n_after then 'PASS' else 'FAIL' end, n_after);
  r := r || format(E'%s old hub_call moved to hub_private.hub_call_pre_trial, not callable by anon/authenticated\n',
    case when to_regprocedure('hub_private.hub_call_pre_trial(text,text,jsonb)') is not null
          and not has_function_privilege('anon', 'hub_private.hub_call_pre_trial(text,text,jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'hub_private.hub_call_pre_trial(text,text,jsonb)', 'execute') then 'PASS' else 'FAIL' end);

  -- 2. a wrong token is refused
  begin perform public.hub_call('wrong', 'trial', '{}'); ok := false; exception when others then ok := sqlerrm = 'not authorised'; end;
  r := r || format(E'%s trial with a wrong token: refused\n', case when ok then 'PASS' else 'FAIL' end);

  -- 3. New customer: add_business through the hub (as the portal does), then the trial
  j := public.hub_call(tok, 'add_business', jsonb_build_object('business', 'NC Trial Test', 'name', 'Nc Tester', 'email', em,
         'mobile', null, 'password', 'Rand0m-' || md5(random()::text), 'contact_email', em));
  org := j->>'account_id';
  r := r || format(E'%s add_business via hub: business made with no licence (%s)\n',
    case when org is not null and not exists (select 1 from public.pe_licences where org_id = org and license_type is not null)
          and not exists (select 1 from public.pe_location_licences where org_id = org and license_type is not null) then 'PASS' else 'FAIL' end, org);

  t := public.hub_call(tok, 'trial', jsonb_build_object('account_id', org));
  e := (t->>'expires_at')::timestamptz;
  own := coalesce(public.pe_trial_owner(org), (select p.member_id from public.pe_people p where p.org_id = org and p.role = 'Owner' limit 1));
  select * into lic from public.pe_licences where org_id = org and member_id = own;
  select * into loc from public.pe_location_licences where org_id = org limit 1;
  r := r || format(E'%s trial via hub: applied, 3 days (%s)\n',
    case when (t->>'applied')::boolean and t->>'license_type' = 'trial3' and abs(extract(epoch from (e - (now() + interval '3 days')))) < 5 then 'PASS' else 'FAIL' end, t);
  r := r || format(E'%s the owner: trial3 until the same time (%s %s)\n',
    case when lic.license_type = 'trial3' and lic.expires_at = e then 'PASS' else 'FAIL' end, lic.license_type, lic.expires_at);
  r := r || format(E'%s its location: trial3 until the same time (%s %s, %s location licence row(s))\n',
    case when loc.license_type = 'trial3' and loc.expires_at = e
          and (select count(*) from public.pe_location_licences where org_id = org) = (select count(*) from public.pe_rows where org_id = org and coll = 'locations' and not deleted)
    then 'PASS' else 'FAIL' end, loc.license_type, loc.expires_at, (select count(*) from public.pe_location_licences where org_id = org));

  -- 4. the portal sees the location trial, and the owner is covered by the staff package
  lst := public.hub_call(tok, 'list', '{}');
  r := r || format(E'%s list: the location unit shows trial3 (%s)\n',
    case when exists (select 1 from jsonb_array_elements(lst->'units') u where u->>'kind' = 'location' and u->>'account_id' = org and u->>'license_type' = 'trial3')
    then 'PASS' else 'FAIL' end,
    (select jsonb_agg(u) from jsonb_array_elements(lst->'units') u where u->>'account_id' = org and u->>'kind' = 'location'));
  r := r || format(E'%s list: the owner''s staff unit is covered (%s)\n',
    case when exists (select 1 from jsonb_array_elements(lst->'units') u where u->>'kind' = 'staff' and u->>'account_id' = org
                       and coalesce((u->>'covered')::boolean, false) and not coalesce((u->>'needs_addon')::boolean, false))
    then 'PASS' else 'FAIL' end,
    (select jsonb_agg(u) from jsonb_array_elements(lst->'units') u where u->>'account_id' = org and u->>'kind' = 'staff'));

  -- 4b. a staff member added during the trial is covered too (the location's 10-person package / staff follow the owner)
  select user_id into ou from public.pe_people where org_id = org and role = 'Owner' limit 1;   -- the owner adds them, as in the app
  perform set_config('request.jwt.claims', json_build_object('sub', ou, 'role', 'authenticated', 'aud', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', ou::text, true);
  insert into public.pe_rows (org_id, coll, id, data, deleted, updated_at)
  values (org, 'members', 'mnctest1', jsonb_build_object('name', 'Nc Staff', 'role', 'Staff', 'email', 'nc-staff-' || em), false, now());
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true);
  lst := public.hub_call(tok, 'list', '{}');
  r := r || format(E'%s list: a staff member added during the trial is covered, no add-on needed (%s)\n',
    case when exists (select 1 from jsonb_array_elements(lst->'units') u where u->>'id' = org || '/mnctest1'
                       and coalesce((u->>'covered')::boolean, false) and not coalesce((u->>'needs_addon')::boolean, false))
    then 'PASS' else 'FAIL' end,
    (select jsonb_agg(u) from jsonb_array_elements(lst->'units') u where u->>'id' = org || '/mnctest1'));

  -- 5. never twice, never over a licence
  t2 := public.hub_call(tok, 'trial', jsonb_build_object('account_id', org));
  r := r || format(E'%s second trial: not applied, end date unchanged (%s)\n',
    case when not (t2->>'applied')::boolean and (select expires_at from public.pe_licences where org_id = org and member_id = own) = e then 'PASS' else 'FAIL' end, t2);

  -- 6. bad ids are refused, and the hub's own claims are put back
  begin perform public.hub_call(tok, 'trial', '{}'); ok := false; exception when others then ok := sqlerrm = 'Business not found.'; end;
  r := r || format(E'%s trial with no business id: refused\n', case when ok then 'PASS' else 'FAIL' end);
  begin perform public.hub_call(tok, 'trial', '{"account_id":"no-such-org"}'); ok := false; exception when others then ok := sqlerrm = 'Business not found.'; end;
  r := r || format(E'%s trial for an unknown business: refused\n', case when ok then 'PASS' else 'FAIL' end);
  r := r || format(E'%s claims put back after the call (sub "%s")\n', case when coalesce(current_setting('request.jwt.claim.sub', true), '') = '' then 'PASS' else 'FAIL' end,
    coalesce(current_setting('request.jwt.claim.sub', true), ''));

  -- 7. the dashboard SSO can hand this owner in (no app password needed: sso-login uses a magic link)
  select to_jsonb(x) into j from public.sso_entitled(em) x;
  r := r || format(E'%s sso_entitled(owner): %s\n', case when (j->>'ok')::boolean then 'PASS' else 'FAIL' end, j);

  -- 8. running the migration again changes nothing
  --MIGRATION--
  r := r || format(E'%s second run: list still works (%s units), trial still answers (applied=%s), old hub_call still the base\n',
    case when jsonb_array_length(public.hub_call(tok, 'list', '{}')->'units') > n_after
          and public.hub_call(tok, 'trial', jsonb_build_object('account_id', org)) ? 'applied'
          and position('hub_private.hub_call_pre_trial' in (select prosrc from pg_proc where oid = 'hub_private.hub_call_pre_trial(text,text,jsonb)'::regprocedure)) = 0
    then 'PASS' else 'FAIL' end,
    jsonb_array_length(public.hub_call(tok, 'list', '{}')->'units'), public.hub_call(tok, 'trial', jsonb_build_object('account_id', org))->>'applied');

  raise exception E'ROLLED BACK. Results:\n%', r;
end $t$;
