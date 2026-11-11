-- 012: a licence per location, with up to 10 staff included per licensed location (PER_LOCATION_LICENCE_SPEC,
-- owner 11 Nov 2026: "A licence does not cover the whole business; additional locations require an additional
-- licence", then for Employee "Employee package", 01:13).
--
-- THE RULE
-- * Every location needs its own licence. A licensed location includes up to 10 staff: the business's allowance is
--   10 x its licensed (not archived) locations.
-- * Who counts: every active member of the business (members records that are not deleted and not archived),
--   the Owner included (the Owner counts as 1).
-- * Staff over the allowance each need a staff add-on: the existing per-staff licence (pe_licences).
-- * Anyone with a valid per-staff licence (add-on, or any licence they had before tonight) is covered whatever the count,
--   so nobody is locked out tonight, and does NOT use one of the package places.
-- * The package places go by join date: the earliest-joined people without a valid add-on are covered first
--   (members.data.joined, then when their login was made, then the member id). If someone earlier leaves or is
--   archived, or a location licence is added, the next person in line is covered automatically: nothing is stored,
--   it is worked out every time by public.pe_staff_coverage(org).
-- * A person is "licensed" (pe_member_licensed, used by pe_access_ok / the existing lock, pe_my_role, pe_whoami
--   and clock-in) if they have a valid add-on, or a package place. The existing rules stay as they are: the
--   7-day grace (none for trial3), suspended businesses, and existing owner-follow licences (migration 007/009).
-- * New members no longer get an owner-follow licence (pe_give_trial): with the package they are covered by the
--   location licence, and copying one person's add-on to everyone would give add-ons away. Licences that already
--   follow the owner keep following.
--
-- LOCATIONS
-- * Storage: a small table public.pe_location_licences (org_id, location_id) -> licence type, start, end, notes, the
--   same shape as public.pe_licences. Locations are jsonb records in pe_rows (coll 'locations') that owners and admins
--   write directly from the app, so licence fields there could be edited by the business; a separate table only
--   the server writes (hub_call 'set' from the licence portal / Stripe) can't be, and it matches pe_licences.
-- * Existing locations: lifetime (once, when the table is created). New locations (Add business, self-signup,
--   hub add_business, a location added in the app): no row = no licence.
-- * Clock-in (entries) and rota shifts at a location need that location's licence; a clock-in with no location
--   needs at least one licensed location in the business. Refused on the server with a clear message.
-- * Everything else (timesheets, leave, payslips, documents, chat, reports, editing past entries) is not tied to a
--   location's licence: it follows the person's own access (package place or add-on), which itself needs at least
--   one licensed location unless the person has an add-on. So a business with one unlicensed location among licensed
--   ones keeps its history and paperwork for that location; only new clock-ins and shifts there are refused.
--
-- THE MASTER'S 3-DAY TRIAL (011 pe_master_trial, from Add business): it now also gives the business's location(s) a
-- 'trial3' licence ending with the trial, so the owner and up to 10 staff per location can clock in during it.
--
-- HUB (see /home/claude/HUB_UNITS.md)
-- * hub_call 'list': staff units get kind 'staff' (the Staff add-on) plus covered / package / needs_addon; location
--   units are added: kind 'location', id 'loc/<org id>/<location id>'.
-- * hub_call 'set': kind 'location' or a 'loc/' unit sets a location; a missing kind is a staff licence, as before.
-- * hub_plans: per-kind prices { "staff": {...}, "location": {...} }, or the old flat form = staff add-on prices.
-- * Stripe: pve__<org>__<member>__<plan> (staff add-on, unchanged) and pve__loc__<org>__<location>__<plan>.
-- Safe to run more than once.

-- 1) Location licences. Existing locations: lifetime (only when the table is first created).
do $$
begin
  if to_regclass('public.pe_location_licences') is null then
    create table public.pe_location_licences (
      org_id       text not null references public.pe_orgs(id) on delete cascade,
      location_id  text not null,
      license_type text check (license_type is null or license_type in ('trial3','m1','m3','m6','m12','m24','m36','lifetime','custom')),
      starts_at    timestamptz,
      expires_at   timestamptz,            -- null = lifetime
      notes        text,
      updated_at   timestamptz not null default now(),
      primary key (org_id, location_id)
    );
    insert into public.pe_location_licences (org_id, location_id, license_type, starts_at, expires_at, notes)
    select r.org_id, r.id, 'lifetime', now(), null, 'Existing location: lifetime (per-location licences, 11 Nov 2026)'
      from public.pe_rows r
     where r.coll = 'locations' and not r.deleted
    on conflict do nothing;
  end if;
end $$;
comment on table public.pe_location_licences is
  'One licence per location (pe_rows coll locations). Written only by the server (hub_call set). No row = no licence.';
alter table public.pe_location_licences enable row level security;
drop policy if exists "read location licences" on public.pe_location_licences;
create policy "read location licences" on public.pe_location_licences for select
  using (public.pe_in_org(org_id) or public.pe_is_master());
revoke all on public.pe_location_licences from anon, authenticated;
grant select on public.pe_location_licences to authenticated;

-- 2) Is a location licensed (same grace as staff licences)?
create or replace function public.pe_location_licensed(o text, loc text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select public.pe_license_ok(l.license_type, l.expires_at) from public.pe_location_licences l
                    where l.org_id = o and l.location_id = loc), false)
$$;

-- The business's allowance: 10 staff per licensed, not archived location.
create or replace function public.pe_staff_allowance(o text) returns integer
language sql stable security definer set search_path = public as $$
  select 10 * count(*)::int
    from public.pe_rows r
    join public.pe_location_licences l on l.org_id = r.org_id and l.location_id = r.id
   where r.org_id = o and r.coll = 'locations' and not r.deleted
     and not coalesce((r.data->>'archived')::boolean, false)
     and public.pe_license_ok(l.license_type, l.expires_at)
$$;

-- 3) Who is covered: every active member, in join order.
--    addon   = has a valid per-staff licence (add-on, or a licence from before tonight)
--    package = one of the business's included places (earliest joined first, people with an add-on don't take one)
--    covered = addon or package
create or replace function public.pe_staff_coverage(o text)
returns table (member_id text, name text, role text, joined_rank integer, addon boolean, package boolean, covered boolean)
language sql stable security definer set search_path = public as $$
  with allow as (select public.pe_staff_allowance(o) as n),
  m as (
    select r.id, coalesce(r.data->>'name', r.id) as nm, coalesce(r.data->>'role', 'Member') as rl,
           case when coalesce(r.data->>'joined', '') ~ '^\d{4}-\d{2}-\d{2}' then left(r.data->>'joined', 10)::date end as jd,
           (select min(p.created_at) from public.pe_people p where p.org_id = r.org_id and p.member_id = r.id) as pc,
           coalesce(public.pe_license_ok(l.license_type, l.expires_at), false) as addon
      from public.pe_rows r
      left join public.pe_licences l on l.org_id = r.org_id and l.member_id = r.id
     where r.org_id = o and r.coll = 'members' and not r.deleted
       and not coalesce((r.data->>'archived')::boolean, false)),
  rk as (
    select m.*, row_number() over (order by jd nulls last, pc nulls last, id) as jr,
           row_number() over (partition by addon order by jd nulls last, pc nulls last, id) as pr
      from m)
  select rk.id, rk.nm, rk.rl, rk.jr::int, rk.addon,
         (not rk.addon and rk.pr <= (select n from allow)),
         (rk.addon or rk.pr <= (select n from allow))
    from rk
   order by rk.jr
$$;

-- 4) Licensed = valid add-on, or a package place. (pe_access_ok, pe_my_member, pe_my_role, pe_whoami and the
--    clock-in check all go through this, so the existing lock works unchanged.)
create or replace function public.pe_member_licensed(o text, m text) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce((select public.pe_license_ok(l.license_type, l.expires_at) from public.pe_licences l
                where l.org_id = o and l.member_id = m), false) then
    return true;
  end if;
  return exists (select 1 from public.pe_staff_coverage(o) c where c.member_id = m and c.package);
end $$;

-- 5) Clock-in and shifts need the location's licence; clock-in also needs the person covered (as before).
create or replace function public.pe_licence_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare loc text := nullif(trim(coalesce(new.data->>'location', '')), ''); lname text;
begin
  if tg_op <> 'INSERT' or new.deleted or new.coll not in ('entries', 'shifts') then return new; end if;
  -- an upsert of a record that already exists is a change, not a new clock-in or shift (clocking out, fixing a
  -- timesheet): allowed, so history at a location stays editable and nobody is stuck clocked in
  if exists (select 1 from public.pe_rows x where x.org_id = new.org_id and x.coll = new.coll and x.id = new.id) then return new; end if;
  if loc is not null and not public.pe_location_licensed(new.org_id, loc) then
    select coalesce(nullif(r.data->>'name', ''), 'This location') into lname from public.pe_rows r
     where r.org_id = new.org_id and r.coll = 'locations' and r.id = loc;
    raise exception '% has no Proview Employee licence yet, so nobody can clock in or be rostered there. The owner can buy the location''s licence online, or call Proview on 020 8935 5495.', coalesce(lname, 'This location');
  end if;
  if new.coll = 'entries' and coalesce(new.member_id, '') <> '' then
    if loc is null and not exists (
         select 1 from public.pe_rows r where r.org_id = new.org_id and r.coll = 'locations' and not r.deleted
            and public.pe_location_licensed(new.org_id, r.id)) then
      raise exception 'No licence yet: this business has no licensed location, so nobody can clock in. The owner can buy a location licence online, or call Proview on 020 8935 5495.';
    end if;
    if not public.pe_member_licensed(new.org_id, new.member_id) then
      raise exception 'This person isn''t included in the business''s staff (10 per licensed location) and has no staff add-on licence, so they can''t clock in. The owner can buy a staff add-on online.';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists pe_licence_check on public.pe_rows;
create trigger pe_licence_check before insert on public.pe_rows
  for each row execute function public.pe_licence_check();

-- 6) New members: listed with no add-on of their own (the package covers them). Licences that already follow an
--    owner keep following (pe_licence_follow, unchanged).
create or replace function public.pe_give_trial(o text, m text, who text) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.pe_licences (org_id, member_id) values (o, m) on conflict do nothing;
end $$;

revoke execute on function public.pe_location_licensed(text, text), public.pe_staff_allowance(text),
  public.pe_staff_coverage(text), public.pe_member_licensed(text, text), public.pe_licence_check(),
  public.pe_give_trial(text, text, text) from public, anon, authenticated;

-- 6b) The master's 3-day trial (011): as before for the owner, plus the same trial on the business's locations.
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
  if (found and cur.license_type is not null)
     or exists (select 1 from public.pe_location_licences l where l.org_id = p_org and l.license_type is not null) then
    return jsonb_build_object('license_type', cur.license_type, 'expires_at', cur.expires_at, 'applied', false);
  end if;
  insert into public.pe_licences (org_id, member_id, license_type, starts_at, expires_at, updated_at)
  values (p_org, m, 'trial3', now(), e, now())
  on conflict (org_id, member_id) do update
    set license_type = 'trial3', starts_at = now(), expires_at = e, updated_at = now();
  insert into public.pe_location_licences (org_id, location_id, license_type, starts_at, expires_at, notes, updated_at)
  select p_org, r.id, 'trial3', now(), e, '3-day trial from Add business', now()
    from public.pe_rows r where r.org_id = p_org and r.coll = 'locations' and not r.deleted
  on conflict (org_id, location_id) do update
    set license_type = 'trial3', starts_at = now(), expires_at = e, notes = excluded.notes, updated_at = now()
    where pe_location_licences.license_type is null;
  return jsonb_build_object('license_type', 'trial3', 'expires_at', e, 'applied', true);
end;
$$;
revoke all on function public.pe_master_trial(text) from public, anon;
grant execute on function public.pe_master_trial(text) to authenticated;

-- 7) What the app shows: locations and their licences, "X of Y staff included", who needs an add-on.
--    Anyone in the business may call it for their own business (also while locked, so the licence screen can offer
--    the right thing to buy); the staff list is for Owners / Admins and the master only.
create or replace function public.pe_licence_status(o text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me text; myrole text; boss boolean; cov jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select p.member_id, p.role into me, myrole from public.pe_people p where p.org_id = o and p.user_id = auth.uid()
   order by (p.role = 'Owner') desc, p.created_at limit 1;
  if me is null and not public.pe_is_master() then raise exception 'You''re not part of this business.'; end if;
  boss := public.pe_is_master() or myrole in ('Owner', 'Admin');
  select coalesce(jsonb_agg(jsonb_build_object('member_id', c.member_id, 'name', c.name, 'role', c.role,
                    'addon', c.addon, 'package', c.package, 'covered', c.covered, 'needs_addon', not c.covered,
                    'license_type', l.license_type, 'expires_at', l.expires_at) order by c.joined_rank), '[]'::jsonb)
    into cov
    from public.pe_staff_coverage(o) c left join public.pe_licences l on l.org_id = o and l.member_id = c.member_id;
  return jsonb_build_object(
    'org_id', o,
    'allowance', public.pe_staff_allowance(o),
    'counted', jsonb_array_length(cov),
    'included', (select count(*) from jsonb_array_elements(cov) x where (x->>'package')::boolean),
    'needs_addon', (select count(*) from jsonb_array_elements(cov) x where not (x->>'covered')::boolean),
    'locations', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', coalesce(r.data->>'name', 'Location'),
                      'archived', coalesce((r.data->>'archived')::boolean, false),
                      'license_type', l.license_type, 'starts_at', l.starts_at, 'expires_at', l.expires_at,
                      'ok', coalesce(public.pe_license_ok(l.license_type, l.expires_at), false)) order by r.data->>'name')
                  from public.pe_rows r left join public.pe_location_licences l on l.org_id = r.org_id and l.location_id = r.id
                 where r.org_id = o and r.coll = 'locations' and not r.deleted), '[]'::jsonb),
    'me', (select x from jsonb_array_elements(cov) x where x->>'member_id' = me),
    'staff', case when boss then cov else null end);
end $$;
revoke all on function public.pe_licence_status(text) from public, anon;
grant execute on function public.pe_licence_status(text) to authenticated;

-- 8) Master overview: as 009, plus locations with their licences, the allowance and each person's coverage.
create or replace function public.pe_master_overview()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.pe_is_master() then raise exception 'Only the master admin can see this.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', o.id, 'name', o.name, 'created_at', o.created_at, 'suspended', o.suspended,
      'self_signup', o.self_signup,
      'contact_email', coalesce(o.contact_email, (select email from auth.users where id = o.created_by)),
      'notes', (select notes from public.pe_org_notes n where n.org_id = o.id),
      'last_active', (select max(updated_at) from public.pe_rows r where r.org_id = o.id),
      'trial_ends_at', (select max(l.expires_at) from public.pe_licences l
                          join public.pe_people p on p.org_id = l.org_id and p.member_id = l.member_id
                         where l.org_id = o.id and p.role = 'Owner' and l.license_type = 'trial3'),
      'paid', exists (select 1 from public.pe_licences l where l.org_id = o.id
                        and l.license_type is not null and l.license_type <> 'trial3')
              or exists (select 1 from public.pe_location_licences ll where ll.org_id = o.id
                        and ll.license_type is not null and ll.license_type <> 'trial3'),
      'licensed_ever', exists (select 1 from public.pe_licences l where l.org_id = o.id
                        and (l.license_type is not null or l.expires_at is not null))
                       or exists (select 1 from public.pe_location_licences ll where ll.org_id = o.id
                        and (ll.license_type is not null or ll.expires_at is not null)),
      'allowance', public.pe_staff_allowance(o.id),
      'locations', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', coalesce(r.data->>'name', 'Location'),
                      'archived', coalesce((r.data->>'archived')::boolean, false),
                      'license_type', ll.license_type, 'starts_at', ll.starts_at, 'expires_at', ll.expires_at) order by r.data->>'name')
                  from public.pe_rows r left join public.pe_location_licences ll on ll.org_id = r.org_id and ll.location_id = r.id
                 where r.org_id = o.id and r.coll = 'locations' and not r.deleted), '[]'::jsonb),
      'staff', coalesce((select jsonb_agg(jsonb_build_object(
          'member_id', r.id, 'name', r.data->>'name', 'email', r.data->>'email',
          'role', coalesce(r.data->>'role', 'Member'),
          'archived', coalesce((r.data->>'archived')::boolean, false),
          'has_login', exists (select 1 from public.pe_people p where p.org_id = o.id and p.member_id = r.id),
          'license_type', l.license_type, 'starts_at', l.starts_at, 'expires_at', l.expires_at, 'license_notes', l.notes,
          'package', coalesce(c.package, false), 'covered', coalesce(c.covered, false))
          order by (r.data->>'role') = 'Owner' desc, r.data->>'name')
        from public.pe_rows r
        left join public.pe_licences l on l.org_id = r.org_id and l.member_id = r.id
        left join public.pe_staff_coverage(o.id) c on c.member_id = r.id
        where r.org_id = o.id and r.coll = 'members' and not r.deleted), '[]'::jsonb)
    ) order by lower(o.name)) from public.pe_orgs o), '[]'::jsonb);
end $$;

-- 9) Prices per kind. hub_plans stores { "staff": {plan: {...}}, "location": {plan: {...}} }; the portal may send that,
--    or the old flat { plan: {...} }, which is the staff (add-on) prices.
create schema if not exists hub_private;
create or replace function hub_private.plans_by_kind(p jsonb)
returns jsonb
language sql
immutable
as $$
  select case
    when p is null or jsonb_typeof(p) <> 'object' then jsonb_build_object('staff', '{}'::jsonb, 'location', '{}'::jsonb)
    when p ? 'location' or p ? 'staff' then
      jsonb_build_object('staff', coalesce(case when jsonb_typeof(p->'staff') = 'object' then p->'staff' end, '{}'::jsonb),
                         'location', coalesce(case when jsonb_typeof(p->'location') = 'object' then p->'location' end, '{}'::jsonb))
    else jsonb_build_object('staff', p, 'location', '{}'::jsonb)
  end
$$;

create or replace function public.hub_plans(p_token text, p_plans jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare k jsonb := hub_private.plans_by_kind(coalesce(p_plans, '{}'::jsonb));
begin
  if p_token is null or encode(extensions.digest(p_token, 'sha256'), 'hex') is distinct from (select token_sha256 from hub_private.config where id = 1) then
    raise exception 'not authorised';
  end if;
  update hub_private.config set plans = k where id = 1;
  return jsonb_build_object('ok', true,
    'plans', (select count(*) from jsonb_object_keys(k->'staff')) + (select count(*) from jsonb_object_keys(k->'location')),
    'staff', (select count(*) from jsonb_object_keys(k->'staff')),
    'location', (select count(*) from jsonb_object_keys(k->'location')));
end $$;
revoke all on function public.hub_plans(text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.hub_plans(text, jsonb) to anon, authenticated, service_role;

-- prices saved before this migration were the staff prices
update hub_private.config set plans = hub_private.plans_by_kind(plans) where id = 1;

-- staff add-on prices (as before, for pages still open on the old code)
create or replace function public.licence_buy_plans()
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select case when auth.uid() is null then '{}'::jsonb
         else coalesce(hub_private.plans_by_kind((select plans from hub_private.config where id = 1)) -> 'staff', '{}'::jsonb) end
$$;
-- every kind: { "staff": {...}, "location": {...} }
create or replace function public.licence_buy_plans_by_kind()
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select case when auth.uid() is null then jsonb_build_object('staff', '{}'::jsonb, 'location', '{}'::jsonb)
         else hub_private.plans_by_kind((select plans from hub_private.config where id = 1)) end
$$;
revoke all on function public.licence_buy_plans(), public.licence_buy_plans_by_kind() from public, anon;
grant execute on function public.licence_buy_plans(), public.licence_buy_plans_by_kind() to authenticated, service_role;

-- 10) hub_call: location units in 'list', location licences in 'set'. Everything else goes to the hub_call that was
--     live before this migration (010's: 'add_business', then 'list' / 'set' for staff), moved aside unchanged as
--     hub_private.hub_call_staff. Run again after any later change to public.hub_call and that newer one becomes the base.
do $$
declare src text := (select prosrc from pg_proc where oid = to_regprocedure('public.hub_call(text,text,jsonb)'));
begin
  if src is null then raise exception 'public.hub_call(text,text,jsonb) is missing.'; end if;
  if position('hub_private.hub_call_staff' in src) = 0 then
    drop function if exists hub_private.hub_call_staff(text, text, jsonb);
    alter function public.hub_call(text, text, jsonb) rename to hub_call_staff;
    alter function public.hub_call_staff(text, text, jsonb) set schema hub_private;
  end if;
end $$;
revoke all on function hub_private.hub_call_staff(text, text, jsonb) from public, anon, authenticated;

create or replace function public.hub_call(p_token text, p_action text, p_args jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  r jsonb; cur public.pe_location_licences; base timestamptz; new_exp timestamptz;
  kind text := lower(nullif(trim(coalesce(p_args->>'kind', '')), ''));
  unit text := coalesce(p_args->>'unit', '');
  t text := nullif(p_args->>'type', '');
  ext boolean := coalesce((p_args->>'extend')::boolean, false);
  cust timestamptz := nullif(p_args->>'expires', '')::timestamptz;
  nt text := p_args->>'notes';
  o text; loc text; rest text;
begin
  if p_token is null or encode(extensions.digest(p_token, 'sha256'), 'hex') is distinct from (select token_sha256 from hub_private.config where id = 1) then
    raise exception 'not authorised';
  end if;

  if p_action = 'list' then
    r := hub_private.hub_call_staff(p_token, p_action, p_args);
    return jsonb_set(r, '{units}',
      coalesce((select jsonb_agg(u || jsonb_build_object('kind', 'staff',
                        'covered', coalesce(c.covered, false), 'package', coalesce(c.package, false),
                        'needs_addon', c.member_id is not null and not c.covered))
                  from jsonb_array_elements(coalesce(r->'units', '[]'::jsonb)) u
                  left join lateral (select * from public.pe_staff_coverage(u->>'account_id') x
                                      where x.member_id = substr(u->>'id', length(u->>'account_id') + 2)) c on true), '[]'::jsonb)
      || coalesce((select jsonb_agg(jsonb_build_object('id', 'loc/' || lr.org_id || '/' || lr.id, 'kind', 'location',
                        'location_id', lr.id, 'account_id', lr.org_id, 'name', coalesce(lr.data->>'name', 'Location'),
                        'detail', 'Location · includes 10 staff',
                        'license_type', l.license_type, 'starts_at', l.starts_at, 'expires_at', l.expires_at, 'notes', l.notes,
                        'archived', coalesce((lr.data->>'archived')::boolean, false)) order by lr.data->>'name')
                  from public.pe_rows lr
                  left join public.pe_location_licences l on l.org_id = lr.org_id and l.location_id = lr.id
                 where lr.coll = 'locations' and not lr.deleted), '[]'::jsonb));

  elsif p_action = 'set' and (kind = 'location' or unit like 'loc/%') then
    rest := case when unit like 'loc/%' then substr(unit, 5) else unit end;
    o := split_part(rest, '/', 1);
    loc := substr(rest, length(o) + 2);
    if o = '' or loc = '' or not exists (select 1 from public.pe_rows where org_id = o and coll = 'locations' and id = loc and not deleted) then
      raise exception 'Location not found';
    end if;
    select * into cur from public.pe_location_licences where org_id = o and location_id = loc for update;
    if t is null then
      update public.pe_location_licences set license_type = null, starts_at = null, expires_at = null, updated_at = now(),
             notes = coalesce(nullif(trim(nt), ''), notes)
       where org_id = o and location_id = loc;
    else
      if t = 'lifetime' then new_exp := null;
      elsif t = 'custom' then
        if cust is null then raise exception 'Choose an end date.'; end if;
        new_exp := cust;
      elsif public.pe_license_interval(t) is not null then
        base := case when ext and cur.license_type is distinct from 'lifetime' and cur.expires_at is not null and cur.expires_at > now()
                     then cur.expires_at else now() end;
        new_exp := base + public.pe_license_interval(t);
      else raise exception 'Unknown licence type %', t;
      end if;
      insert into public.pe_location_licences (org_id, location_id, license_type, starts_at, expires_at, notes, updated_at)
      values (o, loc, t, now(), new_exp, nullif(trim(nt), ''), now())
      on conflict (org_id, location_id) do update
        set license_type = excluded.license_type,
            starts_at = case when ext and pe_location_licences.starts_at is not null then pe_location_licences.starts_at else now() end,
            expires_at = excluded.expires_at,
            notes = coalesce(excluded.notes, pe_location_licences.notes),
            updated_at = now();
    end if;
    select * into cur from public.pe_location_licences where org_id = o and location_id = loc;
    return jsonb_build_object('id', 'loc/' || o || '/' || loc, 'kind', 'location', 'license_type', cur.license_type,
                              'starts_at', cur.starts_at, 'expires_at', cur.expires_at, 'notes', cur.notes);

  elsif p_action = 'set' then
    if kind is not null and kind <> 'staff' then raise exception 'Unknown kind %', kind; end if;
    r := hub_private.hub_call_staff(p_token, p_action, p_args - 'kind');
    return r || jsonb_build_object('kind', 'staff');
  end if;

  return hub_private.hub_call_staff(p_token, p_action, p_args);
end;
$$;
revoke all on function public.hub_call(text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.hub_call(text, text, jsonb) to anon, authenticated, service_role;
