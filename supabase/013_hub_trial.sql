-- 013: the licence portal's "New customer" can start the new business on the 3-day trial (owner, 11 Nov 2026:
-- "ADD THE HOW WILL THEY SIGN UP AND LICENSE OPTIONS TOO", the same Licence cards as this app's Add business).
--
-- The licence hub (edge function licence-hub, action create_business with licence 'trial') calls
-- hub_call(token, 'trial', { account_id }) straight after hub_call 'add_business', with the org id that call returned.
-- It runs this app's own master trial, public.pe_master_trial (011, as changed by 012), unchanged, so it is exactly the
-- master's "3-day trial" from Add business: the owner gets 'trial3' until now() + 3 days (007: staff follow the owner's
-- trial), the business's location(s) get a 'trial3' location licence ending at the same time (012: a licensed location
-- includes the 10-person staff package), and nothing changes if the owner or any location already has a licence.
-- Returns pe_master_trial's { license_type, expires_at, applied }.
-- Only "who may call" differs: the hub token instead of the master's sign-in. For this one call the request runs as this
-- app's master account (pe_masters), which pe_master_trial checks for, and is put back straight after (as 010).
-- The live hub_call ('list', 'set', 'add_business', ...) is kept exactly as it is, moved to hub_private.hub_call_pre_trial.
-- Safe to run more than once. Apply it after any other migration that replaces public.hub_call.

-- 1) Move the live hub_call aside, untouched, as hub_private.hub_call_pre_trial (not callable by the API).
do $$
declare src text := (select prosrc from pg_proc where oid = to_regprocedure('public.hub_call(text,text,jsonb)'));
begin
  if src is null then raise exception 'public.hub_call(text,text,jsonb) is missing.'; end if;
  if position('hub_private.hub_call_pre_trial' in src) = 0 then
    drop function if exists hub_private.hub_call_pre_trial(text, text, jsonb);
    alter function public.hub_call(text, text, jsonb) rename to hub_call_pre_trial;
    alter function public.hub_call_pre_trial(text, text, jsonb) set schema hub_private;
  end if;
end $$;
revoke all on function hub_private.hub_call_pre_trial(text, text, jsonb) from public, anon, authenticated;

-- 2) hub_call: 'trial' here, every other action exactly as before.
create or replace function public.hub_call(p_token text, p_action text, p_args jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  r jsonb; mu uuid; me text; org text := nullif(trim(coalesce(p_args->>'account_id', '')), '');
  c_claims text := current_setting('request.jwt.claims', true);
  c_sub    text := current_setting('request.jwt.claim.sub', true);
  c_claim  text := current_setting('request.jwt.claim', true);
begin
  if p_action is distinct from 'trial' then
    return hub_private.hub_call_pre_trial(p_token, p_action, p_args);
  end if;
  if p_token is null or encode(extensions.digest(p_token, 'sha256'), 'hex') is distinct from (select token_sha256 from hub_private.config where id = 1) then
    raise exception 'not authorised';
  end if;
  if org is null then raise exception 'Business not found.'; end if;

  -- the master's own 3-day trial, run as the master (pe_masters) for this one call
  select m.user_id, lower(u.email) into mu, me from public.pe_masters m join auth.users u on u.id = m.user_id
   order by u.created_at limit 1;
  if mu is null then raise exception 'This app has no Proview master account to start the trial with.'; end if;
  perform set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('sub', mu, 'email', me, 'role', 'authenticated',
                     'aud', 'authenticated', 'is_anonymous', false))::text, true);
  perform set_config('request.jwt.claim.sub', mu::text, true);
  perform set_config('request.jwt.claim', '', true);
  r := public.pe_master_trial(org);
  perform set_config('request.jwt.claims', coalesce(c_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(c_sub, ''), true);
  perform set_config('request.jwt.claim', coalesce(c_claim, ''), true);
  return r || jsonb_build_object('account_id', org);
end;
$$;
revoke all on function public.hub_call(text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.hub_call(text, text, jsonb) to anon, authenticated, service_role;
