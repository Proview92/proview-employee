-- 016: the licence portal can pause / resume a business and delete it completely (owner, 12 Nov 2026).
--   hub_call 'suspend' { account_id, suspended } -> pe_orgs.suspended ("Account on hold": pe_access_ok refuses everyone)
--   hub_call 'delete_account' { account_id }     -> deletes the business and everything in it (pe_orgs cascades:
--                                                   people, rows, licences, invites, notes, trials). Logins are kept.
create or replace function hub_private.pe_hub_admin(p_action text, p_args jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o public.pe_orgs; s boolean;
begin
  select * into o from public.pe_orgs where id = coalesce(p_args->>'account_id', '');
  if p_action = 'suspend' then
    if o.id is null then raise exception 'Business not found.'; end if;
    s := coalesce((p_args->>'suspended')::boolean, true);
    update public.pe_orgs set suspended = s where id = o.id;
    return jsonb_build_object('ok', true, 'account_id', o.id, 'suspended', s);
  end if;
  if o.id is null then return jsonb_build_object('ok', true, 'account_id', p_args->>'account_id', 'deleted', true, 'already', true); end if;
  delete from public.pe_orgs where id = o.id;
  return jsonb_build_object('ok', true, 'account_id', o.id, 'deleted', true);
end $$;
revoke all on function hub_private.pe_hub_admin(text, jsonb) from public, anon, authenticated;

do $p$ declare d text; begin
  d := pg_get_functiondef('public.hub_call(text,text,jsonb)'::regprocedure);
  if position('pe_hub_admin' in d) = 0 then
    execute replace(d, '  if p_action is distinct from ''link'' and p_action is distinct from ''unlink'' then',
      '  if p_action in (''suspend'', ''delete_account'') then
    if p_token is null or encode(extensions.digest(p_token, ''sha256''), ''hex'') is distinct from (select token_sha256 from hub_private.config where id = 1) then
      raise exception ''not authorised'';
    end if;
    return hub_private.pe_hub_admin(p_action, p_args);
  end if;
  if p_action is distinct from ''link'' and p_action is distinct from ''unlink'' then');
  end if;
end $p$;
