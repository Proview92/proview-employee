-- 009: no free trials. Every new business starts with no licence (NO_TRIAL_SPEC, owner 11 Nov 2026).
--
-- Owner: "make all businesses start with inactive, they must purchase a license" / "No trials at all".
--
-- Before: every new member (pe_member_trial on pe_rows, pe_org_owner_trial on pe_people) went through
-- pe_give_trial, which gave a 3-day 'trial3' licence once per person per business. So the master's
-- + Add business (pe_add_business), self-signup (pe_start_trial / pe_create_org), the older
-- pe_master_create_org and staff added to any business all started on a trial.
--
-- Now:
-- * pe_give_trial never gives a trial. A new member gets an unlicensed row (license_type null), which
--   is the existing "no licence" state: pe_access_ok is false, so the person is locked out of the data
--   and can't clock in (pe_licence_check) until a licence is set (licence portal / Stripe -> hub_call 'set').
-- * Staff follow the owner (as migration 007) in every NEW business, whoever created it: a member added
--   after the owner copies the owner's licence (none -> none, so locked) and follows it, so when the
--   owner's licence is bought, the staff are licensed with the same type and end date.
--   pe_orgs.staff_follow_owner marks these businesses. It defaults to true for new businesses;
--   existing businesses keep what they had: self-signup trial businesses (a pe_trial_emails row, i.e.
--   migration 007's rule) follow, businesses Proview added don't.
-- * Staff added later to an EXISTING business that doesn't follow (one Proview added) no longer get their
--   own 3-day trial: they start unlicensed, to be licensed in the licence portal.
-- * pe_start_trial ("Set up your business", kept under its old name so the app keeps working) creates the
--   business, its first location and the Owner with no licence. The one-trial-per-email record
--   (pe_trial_emails) is no longer written or checked; the table is left in place.
-- * pe_master_overview adds `licensed_ever` (any licence type set in the business) so the master's card
--   can read "No licence" instead of "Trial".
-- Existing licences are NOT changed: anything on a trial today keeps its expiry.

alter table public.pe_orgs add column if not exists staff_follow_owner boolean not null default false;
-- existing businesses: follow only where migration 007's rule applied (self-signup trial businesses)
update public.pe_orgs g set staff_follow_owner = true
 where not g.staff_follow_owner and exists (select 1 from public.pe_trial_emails t where t.org_id = g.id);
-- every business created from now on follows its owner
alter table public.pe_orgs alter column staff_follow_owner set default true;
comment on column public.pe_orgs.staff_follow_owner is
  'true = staff licences follow the business owner''s licence (automatic, follows_owner). Default for every business created after migration 009 (no trials).';

-- The member staff follow, for a business whose staff follow the owner, else null:
-- the login that created it, else its first Owner login, else its first Owner member record
-- (businesses Proview adds have no created_by, and pe_master_create_org has only an invite).
create or replace function public.pe_trial_owner(o text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
           (select p.member_id from public.pe_people p
             where p.org_id = g.id and g.created_by is not null and p.user_id = g.created_by limit 1),
           (select p.member_id from public.pe_people p
             where p.org_id = g.id and p.role = 'Owner' order by p.created_at, p.member_id limit 1),
           (select r.id from public.pe_rows r
             where r.org_id = g.id and r.coll = 'members' and not r.deleted and r.data->>'role' = 'Owner'
             order by r.updated_at, r.id limit 1))
    from public.pe_orgs g
   where g.id = o and g.staff_follow_owner
$$;

-- No trials: a new member is listed unlicensed, or (business that follows its owner) copies the owner.
create or replace function public.pe_give_trial(o text, m text, who text) returns void
language plpgsql security definer set search_path = public as $$
declare own text; ol public.pe_licences;
begin
  if exists (select 1 from public.pe_licences where org_id = o and member_id = m) then return; end if;

  own := public.pe_trial_owner(o);
  if own is not null and own is distinct from m then
    -- staff end when the business (owner) does; no owner licence -> no licence
    select * into ol from public.pe_licences where org_id = o and member_id = own;
    insert into public.pe_licences (org_id, member_id, license_type, starts_at, expires_at, follows_owner)
    values (o, m,
            ol.license_type,
            case when ol.license_type is null then null else least(now(), coalesce(ol.expires_at, now())) end,
            case when ol.license_type is null then null else ol.expires_at end,
            true)
    on conflict do nothing;
    return;
  end if;

  -- the owner, or anyone in a business that doesn't follow its owner: no licence until one is bought
  insert into public.pe_licences (org_id, member_id) values (o, m) on conflict do nothing;
end $$;
revoke execute on function public.pe_trial_owner(text), public.pe_give_trial(text, text, text) from public, anon, authenticated;

-- "Set up your business" (self-signup): business, first location and Owner, with no licence.
create or replace function public.pe_start_trial(company text, site_name text, my_member_id text, my_name text default null)
returns text
language plpgsql security definer set search_path = public as $$
declare o text; em text; nm text; site text; loc text;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if public.pe_is_master() then
    raise exception 'The master admin adds businesses from All sites.';
  end if;
  nm := trim(coalesce(company, ''));
  if nm = '' then raise exception 'Enter your business name'; end if;
  if length(nm) > 120 then raise exception 'That business name is too long'; end if;
  site := trim(coalesce(nullif(trim(coalesce(site_name, '')), ''), nm));
  if length(site) > 120 then raise exception 'That site name is too long'; end if;
  if coalesce(trim(my_member_id), '') = '' or length(my_member_id) > 64 then raise exception 'Missing member id'; end if;

  select lower(email) into em from auth.users where id = auth.uid();
  if em is null or em = '' then raise exception 'Your login has no email address'; end if;

  -- an invite counts as joined: link it now, and never set up a second business for someone with one
  perform public.pe_link_invites_for(auth.uid(), em);
  if exists (select 1 from public.pe_people where user_id = auth.uid())
     or exists (select 1 from public.pe_invites where lower(email) = em) then
    raise exception 'You’re already part of a business. Sign in again to open it.' using hint = 'has_business';
  end if;

  insert into public.pe_orgs (name, created_by, contact_email, self_signup, staff_follow_owner)
  values (nm, auth.uid(), em, true, true) returning id into o;

  -- The Owner's member record must be written as an owner (pe_rows_check only lets an owner/admin with a
  -- working licence write an Owner record). So the owner's licence row starts as a one-minute 'custom'
  -- licence for these inserts and is cleared straight after, inside this function: the business ends
  -- with NO licence. (pe_org_owner_trial -> pe_give_trial sees the row and leaves it alone.)
  insert into public.pe_licences (org_id, member_id, license_type, starts_at, expires_at)
  values (o, my_member_id, 'custom', now(), now() + interval '1 minute');
  insert into public.pe_people (org_id, user_id, member_id, role, email)
  values (o, auth.uid(), my_member_id, 'Owner', em);

  -- the owner's member record (the app fills in the rest) and the first location
  insert into public.pe_rows (org_id, coll, id, member_id, data, deleted)
  values (o, 'members', my_member_id, my_member_id,
          jsonb_build_object('id', my_member_id, 'name', coalesce(nullif(trim(coalesce(my_name, '')), ''), em),
                             'role', 'Owner', 'email', em, 'archived', false), false);
  loc := 'l' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
  insert into public.pe_rows (org_id, coll, id, member_id, data, deleted)
  values (o, 'locations', loc, null,
          jsonb_build_object('id', loc, 'name', site, 'address', '', 'lat', 51.5072, 'lng', -0.1276, 'radius', 150, 'archived', false), false);
  -- and now no licence
  update public.pe_licences set license_type = null, starts_at = null, expires_at = null, notes = null, updated_at = now()
   where org_id = o and member_id = my_member_id;
  return o;
end $$;
revoke all on function public.pe_start_trial(text, text, text, text) from public, anon;
grant execute on function public.pe_start_trial(text, text, text, text) to authenticated;

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
                        and l.license_type is not null and l.license_type <> 'trial3'),
      'licensed_ever', exists (select 1 from public.pe_licences l where l.org_id = o.id
                        and (l.license_type is not null or l.expires_at is not null)),
      'staff', coalesce((select jsonb_agg(jsonb_build_object(
          'member_id', r.id, 'name', r.data->>'name', 'email', r.data->>'email',
          'role', coalesce(r.data->>'role', 'Member'),
          'archived', coalesce((r.data->>'archived')::boolean, false),
          'has_login', exists (select 1 from public.pe_people p where p.org_id = o.id and p.member_id = r.id),
          'license_type', l.license_type, 'starts_at', l.starts_at, 'expires_at', l.expires_at, 'license_notes', l.notes)
          order by (r.data->>'role') = 'Owner' desc, r.data->>'name')
        from public.pe_rows r
        left join public.pe_licences l on l.org_id = r.org_id and l.member_id = r.id
        where r.org_id = o.id and r.coll = 'members' and not r.deleted), '[]'::jsonb)
    ) order by lower(o.name)) from public.pe_orgs o), '[]'::jsonb);
end $$;
