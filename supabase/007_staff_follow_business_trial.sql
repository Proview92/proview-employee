-- 007: during a self-signup business trial, staff licences end when the owner's trial ends
--      (owner decision, 8 Nov 2026)
--
-- Before: every new staff member got their own 3-day 'trial3' licence (pe_give_trial), so an
-- owner could keep adding staff after their own trial had ended.
--
-- Now, for a self-signup trial business (one started through pe_start_trial, i.e. it has a
-- pe_trial_emails row):
-- * The owner (the person who started it) still gets the 3-day 'trial3' licence. That licence's
--   expires_at is "the business end date".
-- * Anyone else added gets a 'trial3' licence with expires_at = the business end date, marked
--   follows_owner = true. Added after the end date, it is already expired, so they see the
--   existing "free trial ... ended" message and can't clock in (pe_licence_check).
-- * Whenever the owner's licence changes (master extends it, or the licence portal sets a paid
--   licence through hub_call 'set'), every follows_owner licence in that business moves to the
--   owner's new end date. Owner licence cleared -> following licences are cleared too.
--   Owner lifetime (no end date) -> following licences have no end date either.
-- * A staff licence set explicitly (hub_call 'set', or any write not made by this sync) stops
--   following: the before-update trigger clears follows_owner, so it's never overridden.
-- Businesses added by Proview (pe_master_create_org, master pe_create_org, licence portal) have
-- no pe_trial_emails row and keep the old per-person 3-day trial.

alter table public.pe_licences add column if not exists follows_owner boolean not null default false;
comment on column public.pe_licences.follows_owner is
  'true = automatic staff licence in a self-signup trial business; its end date follows the business owner''s licence. Cleared when the licence is set explicitly.';

-- The business owner's member id for a self-signup trial business, else null.
create or replace function public.pe_trial_owner(o text) returns text
language sql stable security definer set search_path = public as $$
  select p.member_id
    from public.pe_orgs g
    join public.pe_trial_emails t on t.org_id = g.id
    join public.pe_people p on p.org_id = g.id and p.user_id = g.created_by
   where g.id = o
   limit 1
$$;

create or replace function public.pe_give_trial(o text, m text, who text) returns void
language plpgsql security definer set search_path = public as $$
declare own text; ol public.pe_licences;
begin
  if exists (select 1 from public.pe_licences where org_id = o and member_id = m) then return; end if;

  own := public.pe_trial_owner(o);
  if own is not null and own is distinct from m then
    -- self-signup trial business: staff end when the business (owner) does
    select * into ol from public.pe_licences where org_id = o and member_id = own;
    insert into public.pe_trials (org_id, who) values (o, lower(coalesce(nullif(trim(who), ''), m))) on conflict do nothing;
    insert into public.pe_licences (org_id, member_id, license_type, starts_at, expires_at, follows_owner)
    values (o, m,
            case when ol.license_type is null then null else 'trial3' end,
            case when ol.license_type is null then null else least(now(), coalesce(ol.expires_at, now())) end,
            case when ol.license_type is null then null else ol.expires_at end,
            true)
    on conflict do nothing;
    return;
  end if;

  -- everyone else (and the trial owner themself): unchanged, one 3-day trial per person per business
  begin
    insert into public.pe_trials (org_id, who) values (o, lower(coalesce(nullif(trim(who), ''), m)));
  exception when unique_violation then
    insert into public.pe_licences (org_id, member_id) values (o, m) on conflict do nothing;   -- listed, but unlicensed
    return;
  end;
  insert into public.pe_licences (org_id, member_id, license_type, starts_at, expires_at)
  values (o, m, 'trial3', now(), now() + interval '3 days') on conflict do nothing;
end $$;

-- Explicit changes to a following licence stop it following (only the sync below keeps the flag).
create or replace function public.pe_licence_explicit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.follows_owner and coalesce(current_setting('pe.trial_sync', true), '') <> 'on'
     and (new.license_type is distinct from old.license_type
          or new.expires_at is distinct from old.expires_at
          or new.starts_at is distinct from old.starts_at
          or new.notes is distinct from old.notes) then
    new.follows_owner := false;
  end if;
  return new;
end $$;
drop trigger if exists pe_licence_explicit on public.pe_licences;
create trigger pe_licence_explicit before update on public.pe_licences
  for each row execute function public.pe_licence_explicit();

-- When the trial owner's licence changes, following staff licences move with it.
create or replace function public.pe_licence_follow() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.member_id is distinct from public.pe_trial_owner(new.org_id) then return null; end if;
  if tg_op = 'UPDATE' and new.license_type is not distinct from old.license_type
     and new.expires_at is not distinct from old.expires_at then return null; end if;
  perform set_config('pe.trial_sync', 'on', true);
  update public.pe_licences l
     set license_type = case when new.license_type is null then null else 'trial3' end,
         starts_at    = case when new.license_type is null then null else coalesce(l.starts_at, now()) end,
         expires_at   = case when new.license_type is null then null else new.expires_at end,
         updated_at   = now()
   where l.org_id = new.org_id and l.member_id <> new.member_id and l.follows_owner;
  perform set_config('pe.trial_sync', '', true);
  return null;
end $$;
drop trigger if exists pe_licence_follow on public.pe_licences;
create trigger pe_licence_follow after insert or update on public.pe_licences
  for each row execute function public.pe_licence_follow();

revoke execute on function public.pe_trial_owner(text), public.pe_give_trial(text, text, text),
  public.pe_licence_explicit(), public.pe_licence_follow() from public, anon, authenticated;

-- Existing self-signup trial businesses: staff on an automatic trial follow the owner from now on.
-- (Only 'trial3' licences; anything else, or an unlicensed row, was set by hand and is left alone.)
update public.pe_licences l set follows_owner = true
 where l.license_type = 'trial3' and not l.follows_owner
   and public.pe_trial_owner(l.org_id) is not null
   and l.member_id <> public.pe_trial_owner(l.org_id);
select set_config('pe.trial_sync', 'on', true);
update public.pe_licences l
   set expires_at = ow.expires_at,
       license_type = case when ow.license_type is null then null else 'trial3' end,
       updated_at = now()
  from public.pe_licences ow
 where l.follows_owner and ow.org_id = l.org_id and ow.member_id = public.pe_trial_owner(l.org_id)
   and (l.expires_at is distinct from ow.expires_at or l.license_type is distinct from case when ow.license_type is null then null else 'trial3' end);
select set_config('pe.trial_sync', '', true);
