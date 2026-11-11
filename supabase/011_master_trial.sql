-- 011: the master's "+ Add business" can start the business on a 3-day trial (owner decision 11 Nov 2026).
--
-- Owner: "Bring back a trial here only". Everything else stays no-trial (migration 009): self-signup, staff
-- and the licence portal's New customer still start with no licence. Only the master, from the Add business
-- dialog, can choose "3-day trial" for a business they have just added.
--
-- pe_master_trial(p_org): Proview master only. Gives the business's owner (pe_trial_owner, else its first
-- Owner) a 'trial3' licence from now to now + 3 days. It never replaces a licence that is already set
-- (a paid or earlier licence stays as it is). Staff who follow the owner (staff_follow_owner, the default for
-- new businesses) follow it through the existing trigger, so the whole business is on the same trial.
-- Returns { license_type, expires_at, applied }.

create or replace function public.pe_master_trial(p_org text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare m text; cur public.pe_licences; e timestamptz := now() + interval '3 days';
begin
  if not public.pe_is_master() then raise exception 'Only the master admin can start a trial.'; end if;
  if not exists (select 1 from public.pe_orgs where id = p_org) then raise exception 'Business not found.'; end if;
  m := coalesce(public.pe_trial_owner(p_org),
                (select p.member_id from public.pe_people p where p.org_id = p_org and p.role = 'Owner'
                  order by p.created_at, p.member_id limit 1));
  if m is null then raise exception 'This business has no Owner to give the trial to.'; end if;
  select * into cur from public.pe_licences where org_id = p_org and member_id = m;
  if found and cur.license_type is not null then
    return jsonb_build_object('license_type', cur.license_type, 'expires_at', cur.expires_at, 'applied', false);
  end if;
  insert into public.pe_licences (org_id, member_id, license_type, starts_at, expires_at, updated_at)
  values (p_org, m, 'trial3', now(), e, now())
  on conflict (org_id, member_id) do update
    set license_type = 'trial3', starts_at = now(), expires_at = e, updated_at = now();
  return jsonb_build_object('license_type', 'trial3', 'expires_at', e, 'applied', true);
end;
$$;
revoke all on function public.pe_master_trial(text) from public, anon;
grant execute on function public.pe_master_trial(text) to authenticated;
