-- 006: 3-day free trial when someone signs up on their own (TRIAL_SPEC, 8 Nov 2026)
--
-- * pe_trial_emails: one row per email that has started a self-signup business trial.
--   It has NO foreign key to pe_orgs on purpose: deleting the business must not give the
--   email a fresh trial. (pe_trials is keyed (org_id, who) and cascades from pe_orgs, so it
--   only stops a second trial for the same person inside the same business; it was emptied
--   by the 8 Nov wipe along with the businesses.)
-- * pe_start_trial(company, site_name, my_member_id, my_name): the only way a non-master
--   creates a business. Server-side: creates the business, its first site (a "locations"
--   record) and the owner's member record, makes the caller its Owner (the existing
--   pe_org_owner_trial trigger gives the owner a 'trial3' licence ending now() + 3 days),
--   and records the email. Refuses: signed out, the master, anyone already in a business or
--   with a pending invite, and an email that has already had a trial.
-- * pe_create_org: unchanged for the master (All sites -> Add a business); for everyone else
--   it now goes through pe_start_trial, so the one-trial rule can't be skipped.
-- * pe_master_overview: adds trial_ends_at (owner's trial3 expiry) and paid (any non-trial
--   licence in the business) so All sites can show "Trial - ends <date>" / "Trial expired".

create table if not exists public.pe_trial_emails (
  email    text primary key,
  org_id   text,
  used_at  timestamptz not null default now()
);
alter table public.pe_trial_emails enable row level security;
revoke all on public.pe_trial_emails from anon, authenticated;

-- anyone who already created a business keeps counting as "trial used" (none after the wipe)
insert into public.pe_trial_emails (email, org_id, used_at)
select distinct on (lower(u.email)) lower(u.email), o.id, o.created_at
from public.pe_orgs o join auth.users u on u.id = o.created_by
where u.email is not null and not exists (select 1 from public.pe_masters m where m.user_id = u.id)
order by lower(u.email), o.created_at
on conflict do nothing;

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

  -- an invite counts as joined: link it now, and never start a trial for someone with a business
  perform public.pe_link_invites_for(auth.uid(), em);
  if exists (select 1 from public.pe_people where user_id = auth.uid())
     or exists (select 1 from public.pe_invites where lower(email) = em) then
    raise exception 'You’re already part of a business. Sign in again to open it.' using hint = 'has_business';
  end if;

  -- one trial per email, ever (the primary key also settles two attempts at the same moment)
  begin
    insert into public.pe_trial_emails (email) values (em);
  exception when unique_violation then
    raise exception 'This email has already had its free 3-day trial. To carry on, get a licence at https://license.proviewcrm.co.uk or contact Proview: altun@proviewtech.co.uk.'
      using hint = 'trial_used';
  end;

  insert into public.pe_orgs (name, created_by, contact_email, self_signup)
  values (nm, auth.uid(), em, true) returning id into o;
  update public.pe_trial_emails set org_id = o where email = em;

  -- Owner; the pe_org_owner_trial trigger gives the 3-day 'trial3' licence
  insert into public.pe_people (org_id, user_id, member_id, role, email)
  values (o, auth.uid(), my_member_id, 'Owner', em);

  -- the owner's member record (the app fills in the rest) and the first site
  insert into public.pe_rows (org_id, coll, id, member_id, data, deleted)
  values (o, 'members', my_member_id, my_member_id,
          jsonb_build_object('id', my_member_id, 'name', coalesce(nullif(trim(coalesce(my_name, '')), ''), em),
                             'role', 'Owner', 'email', em, 'archived', false), false);
  loc := 'l' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
  insert into public.pe_rows (org_id, coll, id, member_id, data, deleted)
  values (o, 'locations', loc, null,
          jsonb_build_object('id', loc, 'name', site, 'address', '', 'lat', 51.5072, 'lng', -0.1276, 'radius', 150, 'archived', false), false);
  return o;
end $$;
revoke all on function public.pe_start_trial(text, text, text, text) from public, anon;
grant execute on function public.pe_start_trial(text, text, text, text) to authenticated;

create or replace function public.pe_create_org(company text, my_member_id text)
returns text
language plpgsql security definer set search_path = public as $$
declare o text; em text;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  -- everyone but the master starts a business only through the trial rules
  if not public.pe_is_master() then
    return public.pe_start_trial(company, company, my_member_id, null);
  end if;
  if coalesce(trim(company),'') = '' then raise exception 'Enter your company name'; end if;
  select email into em from auth.users where id = auth.uid();
  insert into public.pe_orgs (name, created_by) values (trim(company), auth.uid()) returning id into o;
  insert into public.pe_people (org_id, user_id, member_id, role, email) values (o, auth.uid(), my_member_id, 'Owner', lower(em));
  return o;
end $$;

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
