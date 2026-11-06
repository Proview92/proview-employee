-- =====================================================================
-- Proview Employee — database setup
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to run again: it creates what is missing and replaces rules.
-- =====================================================================
--
-- How the data is kept
--   pe_orgs     one row per company
--   pe_people   who can sign in to which company, as which member and role
--   pe_invites  email invites waiting to be claimed
--   pe_rows     every record of the app, one row each: coll = the kind of
--               record (entries, members, groups, …), id = its id, and
--               member_id = the person it belongs to (for private kinds)
--
-- Who can see what (enforced here, not in the app)
--   Owners and admins     everything in their company
--   Managers              their own records + the people in groups they manage
--                         (everyone, if "managers see all timesheets" is on)
--   Members (staff)       only their own records
--   Shared settings (groups, schedules, projects, locations, leave types,
--   holiday calendars …) are readable by everyone in the company.
-- =====================================================================

create extension if not exists pgcrypto;

-- 1. Tables ------------------------------------------------------------
create table if not exists public.pe_orgs (
  id          text primary key default replace(gen_random_uuid()::text, '-', ''),
  name        text not null,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table if not exists public.pe_people (
  org_id     text not null references public.pe_orgs(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  member_id  text not null,
  role       text not null default 'Member' check (role in ('Owner','Admin','Manager','Member')),
  email      text,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id),
  unique (org_id, member_id)
);
create index if not exists pe_people_user on public.pe_people(user_id);

create table if not exists public.pe_invites (
  org_id     text not null references public.pe_orgs(id) on delete cascade,
  email      text not null,
  member_id  text not null,
  role       text not null default 'Member' check (role in ('Owner','Admin','Manager','Member')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (org_id, member_id)
);
create index if not exists pe_invites_email on public.pe_invites(lower(email));

create table if not exists public.pe_rows (
  org_id     text not null references public.pe_orgs(id) on delete cascade,
  coll       text not null,
  id         text not null,
  member_id  text,
  data       jsonb not null default '{}'::jsonb,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (org_id, coll, id)
);
create index if not exists pe_rows_member on public.pe_rows(org_id, member_id);
create index if not exists pe_rows_updated on public.pe_rows(org_id, updated_at);

-- Master admin (Proview): see section 10
create table if not exists public.pe_masters (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create or replace function public.pe_is_master() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (select 1 from public.pe_masters where user_id = auth.uid())
$$;

-- 2. Who am I? (helpers used by the rules; they bypass the rules themselves)
create or replace function public.pe_my_member(o text) returns text
language sql stable security definer set search_path = public as $$
  select member_id from public.pe_people where org_id = o and user_id = auth.uid()
$$;

create or replace function public.pe_my_role(o text) returns text
language sql stable security definer set search_path = public as $$
  select role from public.pe_people where org_id = o and user_id = auth.uid()
$$;

create or replace function public.pe_in_org(o text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.pe_people where org_id = o and user_id = auth.uid())
$$;

create or replace function public.pe_is_admin(o text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.pe_my_role(o) in ('Owner','Admin'), false)
$$;

-- Is `m` in a group that I manage?
create or replace function public.pe_manages(o text, m text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.pe_my_role(o) = 'Manager' and exists (
    select 1
    from public.pe_rows mem
    join public.pe_rows g
      on g.org_id = mem.org_id and g.coll = 'groups' and not g.deleted
     and g.id = mem.data->>'group'
     and g.data->>'manager' = public.pe_my_member(o)
    where mem.org_id = o and mem.coll = 'members' and mem.id = m and not mem.deleted
      and coalesce(mem.data->>'role','Member') not in ('Owner','Admin'))
$$;

-- Managers may see everyone's timesheets when the owner turns that on.
create or replace function public.pe_mgr_sees_all(o text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.pe_my_role(o) = 'Manager' and coalesce((
    select (data->'perms'->>'mgrViewAllTimesheets')::boolean
    from public.pe_rows where org_id = o and coll = 'settings' and id = 'settings' and not deleted), false)
$$;

-- Can I SEE this person's private records? (pay, PIN, payslips: never widened by "see all")
create or replace function public.pe_can_see(o text, m text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.pe_is_admin(o)
      or (m is not null and m = public.pe_my_member(o))
      or public.pe_manages(o, m)
$$;

-- Timesheet-type records: also visible to managers when "managers see all timesheets" is on
create or replace function public.pe_can_see_time(o text, m text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.pe_can_see(o, m) or public.pe_mgr_sees_all(o)
$$;

-- Can I CHANGE this person's records as their admin/manager (not as themselves)?
create or replace function public.pe_can_manage(o text, m text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.pe_is_admin(o)
      or (m is distinct from public.pe_my_member(o) and public.pe_manages(o, m))
$$;

-- 3. What kind of record is it? ----------------------------------------
--   shared  : everyone in the company reads; admins write (managers for rota/tasks set-up)
--   person  : belongs to member_id; rules per kind below
--   admin   : owners/admins only (managers read notifications/audit for their view)
create or replace function public.pe_kind(c text) returns text
language sql immutable as $$
  select case
    when c in ('org','settings','setup','groups','activities','projects','clients','locations',
               'schedules','policies','calendars','needs','rotaSettings','taskTemplates') then 'shared'
    when c in ('members','secrets','entries','requests','shifts','tasks','docs','approvals','ai') then 'person'
    when c in ('notes','audit','exports','invoices') then 'admin'
    else 'unknown' end
$$;

create or replace function public.pe_can_read(o text, c text, m text) returns boolean
language sql stable security definer set search_path = public as $$
  select case public.pe_kind(c)
    when 'shared' then public.pe_in_org(o)
    when 'person' then
      case
        when c = 'ai'     then m = public.pe_my_member(o)
        when c in ('shifts','tasks') and coalesce(m,'') = '' then public.pe_my_role(o) in ('Owner','Admin','Manager')
        when c in ('entries','approvals','requests','shifts','members') then public.pe_can_see_time(o, m)
        else public.pe_can_see(o, m)
      end
    when 'admin' then
      case
        when c in ('notes','audit') then public.pe_my_role(o) in ('Owner','Admin','Manager')
        when c = 'exports'          then public.pe_is_admin(o) or m = public.pe_my_member(o)
        else public.pe_is_admin(o)
      end
    else false end
$$;

create or replace function public.pe_can_write(o text, c text, m text) returns boolean
language sql stable security definer set search_path = public as $$
  select case public.pe_kind(c)
    when 'shared' then
      case when c in ('needs','rotaSettings','taskTemplates')
           then public.pe_my_role(o) in ('Owner','Admin','Manager')
           else public.pe_is_admin(o) end
    when 'person' then
      case c
        when 'ai'        then m = public.pe_my_member(o)
        when 'members'   then public.pe_can_manage(o, m)
        when 'secrets'   then public.pe_can_manage(o, m)
        when 'approvals' then public.pe_can_manage(o, m)
        when 'shifts'    then public.pe_my_role(o) in ('Owner','Admin','Manager') and (coalesce(m,'') = '' or public.pe_can_see(o, m))
        when 'tasks'     then (coalesce(m,'') = '' and public.pe_my_role(o) in ('Owner','Admin','Manager')) or public.pe_can_see(o, m)
        -- clock-ins, leave requests, tasks, payslip "viewed": the person themselves or their manager/admin
        -- (the checks trigger below limits what a person may change on their own record)
        else public.pe_can_see(o, m)
      end
    when 'admin' then
      case
        when c = 'notes'   then public.pe_my_role(o) in ('Owner','Admin','Manager')
        when c = 'audit'   then public.pe_in_org(o)
        when c = 'exports' then public.pe_is_admin(o) or m = public.pe_my_member(o)
        else public.pe_is_admin(o)
      end
    else false end
$$;

-- 4. Row rules ---------------------------------------------------------
alter table public.pe_orgs    enable row level security;
alter table public.pe_people  enable row level security;
alter table public.pe_invites enable row level security;
alter table public.pe_rows    enable row level security;

drop policy if exists "members read their company" on public.pe_orgs;
create policy "members read their company" on public.pe_orgs for select to authenticated using (public.pe_in_org(id));
drop policy if exists "admins rename company" on public.pe_orgs;
create policy "admins rename company" on public.pe_orgs for update to authenticated using (public.pe_is_admin(id)) with check (public.pe_is_admin(id));

drop policy if exists "see own sign-ins" on public.pe_people;
create policy "see own sign-ins" on public.pe_people for select to authenticated
  using (user_id = auth.uid() or public.pe_is_admin(org_id));
drop policy if exists "admins remove sign-ins" on public.pe_people;
create policy "admins remove sign-ins" on public.pe_people for delete to authenticated
  using (public.pe_is_admin(org_id) and user_id <> auth.uid()
         and (role <> 'Owner' or public.pe_my_role(org_id) = 'Owner'));

drop policy if exists "admins and managers manage invites" on public.pe_invites;
drop policy if exists "see invites" on public.pe_invites;
drop policy if exists "send invites" on public.pe_invites;
drop policy if exists "admins change invites" on public.pe_invites;
drop policy if exists "admins remove invites" on public.pe_invites;
create policy "see invites" on public.pe_invites for select to authenticated
  using (public.pe_can_manage(org_id, member_id));
create policy "send invites" on public.pe_invites for insert to authenticated
  with check (public.pe_can_manage(org_id, member_id)
              and (role = 'Member' or (role in ('Manager','Admin') and public.pe_is_admin(org_id))
                   or (role = 'Owner' and public.pe_my_role(org_id) = 'Owner')));
create policy "admins change invites" on public.pe_invites for update to authenticated
  using (public.pe_is_admin(org_id))
  with check (public.pe_is_admin(org_id) and (role <> 'Owner' or public.pe_my_role(org_id) = 'Owner'));
create policy "admins remove invites" on public.pe_invites for delete to authenticated
  using (public.pe_is_admin(org_id));

drop policy if exists "read rows" on public.pe_rows;
create policy "read rows" on public.pe_rows for select to authenticated
  using (public.pe_can_read(org_id, coll, member_id));
drop policy if exists "add rows" on public.pe_rows;
create policy "add rows" on public.pe_rows for insert to authenticated
  with check (public.pe_can_write(org_id, coll, member_id));
drop policy if exists "change rows" on public.pe_rows;
create policy "change rows" on public.pe_rows for update to authenticated
  using (public.pe_can_write(org_id, coll, member_id))
  with check (public.pe_can_write(org_id, coll, member_id));
-- No hard deletes from the app: records are marked deleted so other devices hear about it.

-- 5. Checks on what people may change on their own records --------------
-- Is this clock-in inside a week whose timesheet has been approved?
-- (approvals are keyed "<member>|<YYYY-MM-DD of the week's first day>")
create or replace function public.pe_week_locked(o text, m text, d jsonb) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.pe_rows a
    where a.org_id = o and a.coll = 'approvals' and a.member_id = m and not a.deleted
      and a.data->>'status' = 'approved'
      and (d ? 'in') and jsonb_typeof(d->'in') = 'number'
      and (case when split_part(a.id,'|',2) ~ '^\d{4}-\d{2}-\d{2}$' then
             (to_timestamp((d->>'in')::double precision / 1000) at time zone 'Europe/London')::date
             between split_part(a.id,'|',2)::date and split_part(a.id,'|',2)::date + 6
           else false end))
$$;

create or replace function public.pe_rows_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  me     text := public.pe_my_member(new.org_id);
  admin  boolean := public.pe_is_admin(new.org_id);
  boss   boolean := public.pe_can_manage(new.org_id, new.member_id)
                    or (coalesce(new.member_id,'') = '' and public.pe_my_role(new.org_id) in ('Owner','Admin','Manager'));
  myrole text := public.pe_my_role(new.org_id);
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  -- the master admin only writes through its own functions (it has no direct write access)
  if public.pe_is_master() then
    if new.coll = 'members' then new.member_id := new.id; end if;
    return new;
  end if;
  -- a record never changes company, kind or id
  if tg_op = 'UPDATE' and (new.org_id, new.coll, new.id) is distinct from (old.org_id, old.coll, old.id) then
    raise exception 'Records cannot be moved';
  end if;
  if tg_op = 'UPDATE' and (new.member_id is distinct from old.member_id) and not (admin or boss) then
    raise exception 'You can''t move this record to someone else';
  end if;

  -- members: the record id is the person. Only owners/admins set roles; only owners make owners.
  if new.coll = 'members' then
    new.member_id := new.id;
    if (tg_op = 'INSERT' and coalesce(new.data->>'role','Member') <> 'Member')
       or (tg_op = 'UPDATE' and new.data->>'role' is distinct from old.data->>'role') then
      if not admin then
        raise exception 'Only an owner or admin can change someone''s role';
      end if;
      if new.data->>'role' = 'Owner' and myrole <> 'Owner' then
        raise exception 'Only an owner can make someone an owner';
      end if;
    end if;
  end if;

  -- the change log: written by its author only, never edited
  if new.coll = 'audit' and not admin then
    if tg_op = 'UPDATE' then raise exception 'The change log can''t be edited'; end if;
    if new.data->>'by' is distinct from public.pe_my_member(new.org_id) then
      raise exception 'Change log entries must be your own';
    end if;
  end if;

  -- only an owner changes an owner's role, and a company always keeps an owner
  if new.coll = 'members' and tg_op = 'UPDATE' and old.data->>'role' = 'Owner'
     and (new.data->>'role' is distinct from 'Owner' or new.deleted or coalesce((new.data->>'archived')::boolean,false)) then
    if public.pe_my_role(new.org_id) <> 'Owner' then
      raise exception 'Only an owner can change another owner';
    end if;
    if (select count(*) from public.pe_rows r where r.org_id = new.org_id and r.coll = 'members' and r.id <> new.id
          and not r.deleted and r.data->>'role' = 'Owner' and not coalesce((r.data->>'archived')::boolean,false)) = 0 then
      raise exception 'The company needs at least one owner';
    end if;
  end if;

  -- staff acting on their own records (not as a manager/admin)
  if not (admin or boss) then
    if new.coll = 'requests' then
      if tg_op = 'INSERT' and (coalesce(new.data->>'status','pending') <> 'pending' or new.deleted) then
        raise exception 'Leave requests start as pending';
      end if;
      -- a person may change or cancel their request only while it is still pending
      if tg_op = 'UPDATE' and (coalesce(old.data->>'status','pending') <> 'pending' or old.deleted
         or coalesce(new.data->>'status','pending') <> 'pending') then
        raise exception 'Only a manager can change leave once it has been decided';
      end if;
    elsif new.coll = 'entries' then
      -- clock-ins in a week that has been approved are locked
      if public.pe_week_locked(new.org_id, new.member_id, new.data)
         or (tg_op = 'UPDATE' and public.pe_week_locked(old.org_id, old.member_id, old.data)) then
        raise exception 'That week''s timesheet has been approved, so it can''t be changed';
      end if;
    elsif new.coll = 'docs' then
      if tg_op = 'INSERT' or (new.data - 'viewedAt') is distinct from (old.data - 'viewedAt') or new.deleted <> old.deleted then
        raise exception 'Only a manager can add or change payslips and P45s';
      end if;
    elsif new.coll = 'tasks' then
      if tg_op = 'INSERT' or new.deleted <> old.deleted
         or (new.data - array['status','doneAt','doneBy','checklist']) is distinct from (old.data - array['status','doneAt','doneBy','checklist']) then
        raise exception 'You can only tick off your own tasks';
      end if;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists pe_rows_check on public.pe_rows;
create trigger pe_rows_check before insert or update on public.pe_rows
  for each row execute function public.pe_rows_check();

-- When someone asks for leave, let the managers know (staff can't write notifications themselves)
create or replace function public.pe_notify_request() returns trigger
language plpgsql security definer set search_path = public as $$
declare nm text;
begin
  if new.coll = 'requests' and tg_op = 'INSERT' and coalesce(new.data->>'status','pending') = 'pending'
     and new.member_id = public.pe_my_member(new.org_id) and not public.pe_is_admin(new.org_id) then
    select data->>'name' into nm from public.pe_rows where org_id = new.org_id and coll = 'members' and id = new.member_id;
    insert into public.pe_rows (org_id, coll, id, data)
    values (new.org_id, 'notes', 'req-' || new.id,
            jsonb_build_object('id', 'req-' || new.id, 'icon', 'plane', 'read', false,
                               'at', (extract(epoch from now()) * 1000)::bigint,
                               'text', coalesce(nm, 'Someone') || ' asked for time off'))
    on conflict do nothing;
  end if;
  return null;
end $$;
drop trigger if exists pe_notify_request on public.pe_rows;
create trigger pe_notify_request after insert on public.pe_rows
  for each row execute function public.pe_notify_request();

-- Keep sign-in roles in step with the People page
create or replace function public.pe_sync_role() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.coll = 'members' then
    update public.pe_people
       set role = case when new.data->>'role' in ('Owner','Admin','Manager','Member') then new.data->>'role' else 'Member' end
     where org_id = new.org_id and member_id = new.id;
    if new.deleted or coalesce((new.data->>'archived')::boolean, false) then
      delete from public.pe_people where org_id = new.org_id and member_id = new.id and role <> 'Owner';
    end if;
  end if;
  return null;
end $$;
drop trigger if exists pe_sync_role on public.pe_rows;
create trigger pe_sync_role after insert or update on public.pe_rows
  for each row execute function public.pe_sync_role();

-- 6. Accounts, companies and invites -------------------------------------
-- An invite links the person as soon as an account with that email exists.
create or replace function public.pe_link_invites_for(uid uuid, em text) returns void
language plpgsql security definer set search_path = public as $$
begin
  -- only once the person has proved they own the email address
  if not exists (select 1 from auth.users where id = uid and email_confirmed_at is not null and lower(email) = lower(em)) then
    return;
  end if;
  insert into public.pe_people (org_id, user_id, member_id, role, email)
  select i.org_id, uid, i.member_id,
         coalesce((select case when r.data->>'role' in ('Owner','Admin','Manager','Member') then r.data->>'role' end
                   from public.pe_rows r where r.org_id = i.org_id and r.coll = 'members' and r.id = i.member_id and not r.deleted), 'Member'),
         lower(em)
  from public.pe_invites i
  where lower(i.email) = lower(em)
    and exists (select 1 from public.pe_rows r where r.org_id = i.org_id and r.coll = 'members' and r.id = i.member_id
                and not r.deleted and not coalesce((r.data->>'archived')::boolean, false))
  on conflict do nothing;
  delete from public.pe_invites i where lower(i.email) = lower(em)
    and exists (select 1 from public.pe_people p where p.org_id = i.org_id and p.user_id = uid);
end $$;

create or replace function public.pe_on_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.pe_link_invites_for(new.id, new.email);
  return new;
end $$;
drop trigger if exists pe_on_new_user on auth.users;
create trigger pe_on_new_user after insert or update of email_confirmed_at on auth.users
  for each row when (new.email_confirmed_at is not null)
  execute function public.pe_on_new_user();

create or replace function public.pe_on_invite() returns trigger
language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
  select id into u from auth.users where lower(email) = lower(new.email) and email_confirmed_at is not null limit 1;
  if u is not null then perform public.pe_link_invites_for(u, new.email); end if;
  return null;
end $$;
drop trigger if exists pe_on_invite on public.pe_invites;
create trigger pe_on_invite after insert or update on public.pe_invites
  for each row execute function public.pe_on_invite();

-- Called by the app after sign-in: picks up any invites, returns my companies.
-- (replaced in section 14 with licence details)
drop function if exists public.pe_whoami();
create or replace function public.pe_whoami()
returns table (org_id text, org_name text, member_id text, role text)
language plpgsql security definer set search_path = public as $$
declare em text;
begin
  if auth.uid() is null then return; end if;
  select email into em from auth.users where id = auth.uid();
  perform public.pe_link_invites_for(auth.uid(), em);
  return query
    select p.org_id, o.name, p.member_id, p.role
    from public.pe_people p join public.pe_orgs o on o.id = p.org_id
    where p.user_id = auth.uid()
    order by p.created_at;
end $$;

-- "Create an account": makes the company with me as its owner.
create or replace function public.pe_create_org(company text, my_member_id text)
returns text
language plpgsql security definer set search_path = public as $$
declare o text; em text;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if coalesce(trim(company),'') = '' then raise exception 'Enter your company name'; end if;
  if (select count(*) from public.pe_orgs where created_by = auth.uid()) >= 3 then
    raise exception 'You''ve reached the maximum number of companies for one account';
  end if;
  select email into em from auth.users where id = auth.uid();
  insert into public.pe_orgs (name, created_by) values (trim(company), auth.uid()) returning id into o;
  insert into public.pe_people (org_id, user_id, member_id, role, email) values (o, auth.uid(), my_member_id, 'Owner', lower(em));
  return o;
end $$;

-- (an earlier version had pe_has_invite; removed so nobody can test which emails are invited)
drop function if exists public.pe_has_invite(text);

-- 7. Files: payslips, P45s (bucket "pe-files", path <org>/<member>/<file>) --
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pe-files', 'pe-files', false, 10485760, array['application/pdf','image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false, file_size_limit = 10485760,
  allowed_mime_types = array['application/pdf','image/jpeg','image/png','image/webp'];

drop policy if exists "pe read own files" on storage.objects;
create policy "pe read own files" on storage.objects for select to authenticated
  using (bucket_id = 'pe-files' and public.pe_can_see(split_part(name,'/',1), split_part(name,'/',2)));
drop policy if exists "pe managers add files" on storage.objects;
create policy "pe managers add files" on storage.objects for insert to authenticated
  with check (bucket_id = 'pe-files' and public.pe_can_manage(split_part(name,'/',1), split_part(name,'/',2)));
drop policy if exists "pe managers change files" on storage.objects;
create policy "pe managers change files" on storage.objects for update to authenticated
  using (bucket_id = 'pe-files' and public.pe_can_manage(split_part(name,'/',1), split_part(name,'/',2)));
drop policy if exists "pe managers remove files" on storage.objects;
create policy "pe managers remove files" on storage.objects for delete to authenticated
  using (bucket_id = 'pe-files' and public.pe_can_manage(split_part(name,'/',1), split_part(name,'/',2)));

-- 8. Access for the app ---------------------------------------------------
revoke all on public.pe_orgs, public.pe_people, public.pe_invites, public.pe_rows from anon;
grant select, update on public.pe_orgs to authenticated;
grant select, delete on public.pe_people to authenticated;
grant select, insert, update, delete on public.pe_invites to authenticated;
grant select, insert, update on public.pe_rows to authenticated;
grant all on public.pe_orgs, public.pe_people, public.pe_invites, public.pe_rows to service_role;

revoke all on function public.pe_whoami(), public.pe_create_org(text, text) from public, anon;
grant execute on function public.pe_whoami(), public.pe_create_org(text, text) to authenticated;
revoke execute on function public.pe_link_invites_for(uuid, text) from public, anon, authenticated;
revoke execute on function public.pe_my_member(text), public.pe_my_role(text), public.pe_in_org(text), public.pe_is_admin(text),
  public.pe_manages(text, text), public.pe_mgr_sees_all(text), public.pe_can_see(text, text), public.pe_can_see_time(text, text),
  public.pe_can_manage(text, text), public.pe_can_read(text, text, text), public.pe_can_write(text, text, text),
  public.pe_week_locked(text, text, jsonb) from public, anon;
grant execute on function public.pe_my_member(text), public.pe_my_role(text), public.pe_in_org(text), public.pe_is_admin(text),
  public.pe_manages(text, text), public.pe_mgr_sees_all(text), public.pe_can_see(text, text), public.pe_can_see_time(text, text),
  public.pe_can_manage(text, text), public.pe_can_read(text, text, text), public.pe_can_write(text, text, text),
  public.pe_week_locked(text, text, jsonb) to authenticated;
revoke execute on function public.pe_rows_check(), public.pe_sync_role(), public.pe_on_new_user(), public.pe_on_invite(),
  public.pe_notify_request() from public, anon, authenticated;

-- 9. Live updates between devices ------------------------------------------
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'pe_rows') then
    alter publication supabase_realtime add table public.pe_rows;
  end if;
end $$;

-- =====================================================================
-- 10. Master admin and per-staff licences (same rules as Proview Signage, one licence per staff member)
--   • new staff start on a 3-day trial (once per person per company)
--   • 1, 3, 6, 12, 24 or 36 months, lifetime, or a custom end date; renewals can stack
--   • after the end date: 7 days' grace (none for trials), then that person is locked out
--   • only the master admin changes licences; a business can be suspended
--   • the master admin sees businesses, staff and licences, never timesheets, pay or files
-- =====================================================================
-- Tables -------------------------------------------------------------
create table if not exists public.pe_masters (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.pe_orgs add column if not exists suspended     boolean not null default false;
alter table public.pe_orgs add column if not exists contact_email text;
alter table public.pe_orgs add column if not exists self_signup   boolean not null default true;

create table if not exists public.pe_org_notes (
  org_id     text primary key references public.pe_orgs(id) on delete cascade,
  notes      text,
  updated_at timestamptz not null default now()
);

create table if not exists public.pe_licences (
  org_id       text not null references public.pe_orgs(id) on delete cascade,
  member_id    text not null,
  license_type text check (license_type is null or license_type in ('trial3','m1','m3','m6','m12','m24','m36','lifetime','custom')),
  starts_at    timestamptz,
  expires_at   timestamptz,          -- null with 'lifetime'
  notes        text,
  updated_at   timestamptz not null default now(),
  primary key (org_id, member_id)
);
create index if not exists pe_licences_exp on public.pe_licences(expires_at);

create table if not exists public.pe_trials (
  org_id  text not null references public.pe_orgs(id) on delete cascade,
  who     text not null,
  used_at timestamptz not null default now(),
  primary key (org_id, who)
);

-- 11. Licence helpers ------------------------------------------------------
create or replace function public.pe_is_master() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and exists (select 1 from public.pe_masters where user_id = auth.uid())
$$;

-- Keep in step with LIC_GRACE_DAYS in the app
create or replace function public.pe_license_grace() returns interval language sql immutable as $$ select interval '7 days' $$;

create or replace function public.pe_license_ok(t text, e timestamptz) returns boolean
language sql stable as $$
  select t is not null and (t = 'lifetime' or e is null
         or e + (case when t = 'trial3' then interval '0' else public.pe_license_grace() end) > now())
$$;

create or replace function public.pe_license_interval(t text) returns interval
language sql immutable as $$
  select case t when 'trial3' then interval '3 days'
    when 'm1' then interval '1 month'  when 'm3' then interval '3 months'  when 'm6' then interval '6 months'
    when 'm12' then interval '12 months' when 'm24' then interval '24 months' when 'm36' then interval '36 months' end
$$;

create or replace function public.pe_member_licensed(o text, m text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select public.pe_license_ok(l.license_type, l.expires_at) from public.pe_licences l
                    where l.org_id = o and l.member_id = m), false)
$$;

-- Is this person allowed in right now? (company not suspended and their licence is current)
create or replace function public.pe_access_ok(o text, m text) returns boolean
language sql stable security definer set search_path = public as $$
  select m is not null
     and not coalesce((select suspended from public.pe_orgs where id = o), true)
     and public.pe_member_licensed(o, m)
$$;

-- Every rule goes through these two, so a locked person gets nothing.
create or replace function public.pe_my_member(o text) returns text
language sql stable security definer set search_path = public as $$
  select p.member_id from public.pe_people p
   where p.org_id = o and p.user_id = auth.uid() and public.pe_access_ok(o, p.member_id)
$$;

create or replace function public.pe_my_role(o text) returns text
language sql stable security definer set search_path = public as $$
  select p.role from public.pe_people p
   where p.org_id = o and p.user_id = auth.uid() and public.pe_access_ok(o, p.member_id)
$$;

create or replace function public.pe_in_org(o text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.pe_my_member(o) is not null
$$;

-- 12. Trials for new staff -------------------------------------------------
create or replace function public.pe_give_trial(o text, m text, who text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.pe_licences where org_id = o and member_id = m) then return; end if;
  begin
    insert into public.pe_trials (org_id, who) values (o, lower(coalesce(nullif(trim(who), ''), m)));
  exception when unique_violation then
    insert into public.pe_licences (org_id, member_id) values (o, m) on conflict do nothing;   -- listed, but unlicensed
    return;
  end;
  insert into public.pe_licences (org_id, member_id, license_type, starts_at, expires_at)
  values (o, m, 'trial3', now(), now() + interval '3 days') on conflict do nothing;
end $$;

create or replace function public.pe_member_trial() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.coll = 'members' and not new.deleted then
    perform public.pe_give_trial(new.org_id, new.id, coalesce(nullif(new.data->>'email', ''), new.data->>'name'));
  end if;
  return null;
end $$;
drop trigger if exists pe_member_trial on public.pe_rows;
create trigger pe_member_trial after insert on public.pe_rows
  for each row execute function public.pe_member_trial();

-- The person who creates a company gets their trial straight away (before their member record is saved)
create or replace function public.pe_org_owner_trial() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.pe_give_trial(new.org_id, new.member_id, coalesce(new.email, new.member_id));
  return null;
end $$;
drop trigger if exists pe_org_owner_trial on public.pe_people;
create trigger pe_org_owner_trial after insert on public.pe_people
  for each row when (new.role = 'Owner') execute function public.pe_org_owner_trial();

-- 13. No clock-ins for people whose licence has run out --------------------
create or replace function public.pe_licence_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.coll = 'entries' and tg_op = 'INSERT' and not new.deleted and coalesce(new.member_id, '') <> ''
     and not public.pe_member_licensed(new.org_id, new.member_id) then
    raise exception 'This person''s Proview Employee licence has ended, so they can''t clock in. Ask Proview to renew it.';
  end if;
  return new;
end $$;
drop trigger if exists pe_licence_check on public.pe_rows;
create trigger pe_licence_check before insert on public.pe_rows
  for each row execute function public.pe_licence_check();

-- 14. Who am I, now with licence and lock state ----------------------------
drop function if exists public.pe_whoami();
create or replace function public.pe_whoami()
returns table (org_id text, org_name text, member_id text, role text,
               license_type text, license_expires_at timestamptz, locked boolean, suspended boolean, is_master boolean)
language plpgsql security definer set search_path = public as $$
declare em text;
begin
  if auth.uid() is null then return; end if;
  select email into em from auth.users where id = auth.uid();
  perform public.pe_link_invites_for(auth.uid(), em);
  return query
    select p.org_id, o.name, p.member_id, p.role, l.license_type, l.expires_at,
           not public.pe_access_ok(p.org_id, p.member_id), o.suspended, public.pe_is_master()
    from public.pe_people p
    join public.pe_orgs o on o.id = p.org_id
    left join public.pe_licences l on l.org_id = p.org_id and l.member_id = p.member_id
    where p.user_id = auth.uid()
    order by p.created_at;
end $$;

create or replace function public.pe_am_master() returns boolean
language sql stable security definer set search_path = public as $$ select public.pe_is_master() $$;

-- 15. Licences in the business's own app (owners and admins can read, not change)
alter table public.pe_licences enable row level security;
alter table public.pe_masters  enable row level security;
alter table public.pe_org_notes enable row level security;
alter table public.pe_trials enable row level security;
drop policy if exists "admins read licences" on public.pe_licences;
create policy "admins read licences" on public.pe_licences for select to authenticated
  using (public.pe_is_admin(org_id) or member_id = public.pe_my_member(org_id) or public.pe_is_master());
drop policy if exists "master manages licences" on public.pe_licences;
create policy "master manages licences" on public.pe_licences for all to authenticated
  using (public.pe_is_master()) with check (public.pe_is_master());
drop policy if exists "master reads masters" on public.pe_masters;
create policy "master reads masters" on public.pe_masters for select to authenticated using (user_id = auth.uid());
drop policy if exists "master notes" on public.pe_org_notes;
create policy "master notes" on public.pe_org_notes for all to authenticated
  using (public.pe_is_master()) with check (public.pe_is_master());
drop policy if exists "master reads companies" on public.pe_orgs;
create policy "master reads companies" on public.pe_orgs for select to authenticated using (public.pe_is_master());

-- 16. Master admin functions -------------------------------------------------
-- Everything the master page shows: companies, their people and licences (no timesheets, pay or files)
create or replace function public.pe_master_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.pe_is_master() then raise exception 'Only the master admin can see this.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', o.id, 'name', o.name, 'created_at', o.created_at, 'suspended', o.suspended,
      'self_signup', o.self_signup,
      'contact_email', coalesce(o.contact_email, (select email from auth.users where id = o.created_by)),
      'notes', (select notes from public.pe_org_notes n where n.org_id = o.id),
      'last_active', (select max(updated_at) from public.pe_rows r where r.org_id = o.id),
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

create or replace function public.pe_set_license(o text, m text, t text, extend boolean default false,
                                                 custom_end timestamptz default null, note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare cur public.pe_licences; base timestamptz; new_exp timestamptz;
begin
  if not public.pe_is_master() then raise exception 'Only the master admin can change licences.'; end if;
  if not exists (select 1 from public.pe_rows where org_id = o and coll = 'members' and id = m and not deleted) then
    raise exception 'Staff member not found';
  end if;
  select * into cur from public.pe_licences where org_id = o and member_id = m for update;
  if t = 'lifetime' then new_exp := null;
  elsif t = 'custom' then
    if custom_end is null then raise exception 'Choose an end date.'; end if;
    new_exp := custom_end;
  elsif public.pe_license_interval(t) is not null then
    base := case when extend and cur.license_type is distinct from 'lifetime'
                      and cur.expires_at is not null and cur.expires_at > now() then cur.expires_at else now() end;
    new_exp := base + public.pe_license_interval(t);
  else raise exception 'Unknown licence type %', t;
  end if;
  insert into public.pe_licences (org_id, member_id, license_type, starts_at, expires_at, notes, updated_at)
  values (o, m, t, now(), new_exp, nullif(trim(note), ''), now())
  on conflict (org_id, member_id) do update
    set license_type = excluded.license_type,
        starts_at = case when extend and pe_licences.starts_at is not null then pe_licences.starts_at else now() end,
        expires_at = excluded.expires_at,
        notes = coalesce(excluded.notes, pe_licences.notes),
        updated_at = now();
end $$;

create or replace function public.pe_remove_license(o text, m text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.pe_is_master() then raise exception 'Only the master admin can change licences.'; end if;
  update public.pe_licences set license_type = null, starts_at = null, expires_at = null, updated_at = now()
   where org_id = o and member_id = m;
end $$;

create or replace function public.pe_master_update_org(o text, new_name text, email text, note text, is_suspended boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.pe_is_master() then raise exception 'Only the master admin can change businesses.'; end if;
  update public.pe_orgs
     set name = coalesce(nullif(trim(new_name), ''), name),
         contact_email = nullif(lower(trim(coalesce(email, ''))), ''),
         suspended = coalesce(is_suspended, suspended)
   where id = o;
  insert into public.pe_org_notes (org_id, notes, updated_at) values (o, nullif(trim(note), ''), now())
  on conflict (org_id) do update set notes = excluded.notes, updated_at = now();
end $$;

-- Add a business for a customer: its owner gets an invite and signs up with that email
create or replace function public.pe_master_create_org(company text, owner_name text, owner_email text, note text default null)
returns text language plpgsql security definer set search_path = public as $$
declare o text; m text := 'm' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
        em text := nullif(lower(trim(coalesce(owner_email, ''))), '');
begin
  if not public.pe_is_master() then raise exception 'Only the master admin can add businesses.'; end if;
  if coalesce(trim(company), '') = '' then raise exception 'Enter the business name.'; end if;
  if em is null or em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter the owner''s email address.'; end if;
  insert into public.pe_orgs (name, contact_email, self_signup) values (trim(company), em, false) returning id into o;
  insert into public.pe_rows (org_id, coll, id, member_id, data)
  values (o, 'members', m, m, jsonb_build_object('id', m, 'name', coalesce(nullif(trim(owner_name), ''), split_part(em, '@', 1)),
          'role', 'Owner', 'email', em, 'group', '', 'archived', false, 'color', '#4a6cd0',
          'joined', to_char(now() at time zone 'Europe/London', 'YYYY-MM-DD')));
  insert into public.pe_rows (org_id, coll, id, data)
  values (o, 'org', 'org', jsonb_build_object('name', trim(company), 'email', em));
  insert into public.pe_invites (org_id, email, member_id, role) values (o, em, m, 'Owner');
  if nullif(trim(coalesce(note, '')), '') is not null then insert into public.pe_org_notes (org_id, notes) values (o, trim(note)); end if;
  return o;
end $$;

create or replace function public.pe_master_delete_org(o text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.pe_is_master() then raise exception 'Only the master admin can delete businesses.'; end if;
  -- stored files: removed here where Supabase allows it (otherwise they stay, unreachable)
  begin
    delete from storage.objects where bucket_id = 'pe-files' and split_part(name, '/', 1) = o;
  exception when others then null;
  end;
  delete from public.pe_orgs where id = o;
end $$;

-- 17. Existing companies: everyone starts a 3-day trial from today ----------
insert into public.pe_licences (org_id, member_id, license_type, starts_at, expires_at)
select r.org_id, r.id, 'trial3', now(), now() + interval '3 days'
  from public.pe_rows r
 where r.coll = 'members' and not r.deleted
on conflict do nothing;
insert into public.pe_licences (org_id, member_id, license_type, starts_at, expires_at)
select p.org_id, p.member_id, 'trial3', now(), now() + interval '3 days' from public.pe_people p
on conflict do nothing;
insert into public.pe_trials (org_id, who)
select org_id, member_id from public.pe_licences on conflict do nothing;

-- 18. Access ----------------------------------------------------------------
grant select on public.pe_licences, public.pe_masters to authenticated;
grant select, insert, update, delete on public.pe_org_notes, public.pe_licences to authenticated;
revoke all on public.pe_licences, public.pe_masters, public.pe_org_notes, public.pe_trials from anon;
grant all on public.pe_licences, public.pe_masters, public.pe_org_notes, public.pe_trials to service_role;

revoke execute on function public.pe_give_trial(text, text, text), public.pe_member_trial(), public.pe_org_owner_trial(),
  public.pe_licence_check() from public, anon, authenticated;
revoke execute on function public.pe_whoami(), public.pe_am_master(), public.pe_master_overview(),
  public.pe_set_license(text, text, text, boolean, timestamptz, text), public.pe_remove_license(text, text),
  public.pe_master_update_org(text, text, text, text, boolean), public.pe_master_create_org(text, text, text, text),
  public.pe_master_delete_org(text), public.pe_is_master(), public.pe_member_licensed(text, text),
  public.pe_access_ok(text, text) from public, anon;
grant execute on function public.pe_whoami(), public.pe_am_master(), public.pe_master_overview(),
  public.pe_set_license(text, text, text, boolean, timestamptz, text), public.pe_remove_license(text, text),
  public.pe_master_update_org(text, text, text, text, boolean), public.pe_master_create_org(text, text, text, text),
  public.pe_master_delete_org(text), public.pe_is_master() to authenticated;
revoke execute on function public.pe_member_licensed(text, text), public.pe_access_ok(text, text) from authenticated;
alter function public.pe_license_grace() set search_path = public;
alter function public.pe_license_ok(text, timestamptz) set search_path = public;
alter function public.pe_license_interval(text) set search_path = public;
comment on table public.pe_trials is 'Internal: who has had a free trial. No direct access; written by pe_give_trial only.';

-- Make yourself the master admin (sign up on the site first):
--   insert into public.pe_masters (user_id) select id from auth.users where email = 'altun@proviewtech.co.uk' on conflict do nothing;
