-- =====================================================================
-- Proview Employee — access model: per-site scope and per-feature toggles
-- (applied live as migrations pe_access_model_columns / _helpers / _rules / _sync / _policies)
--
-- Roles (stored values unchanged): Owner, Admin = whole business; Manager; Member (= Staff).
-- Sites   = the business's Locations (pe_rows coll 'locations').
--   A person's sites live on their People record (members.data.sites = ["locId", ...])
--   and are mirrored to pe_people.site_ids / pe_invites.site_ids for their sign-in.
--   No sites (null / empty) = every site, so nobody loses access on deploy.
--   Managers and Members see only records linked to their sites (entries, shifts, tasks,
--   needs, task templates have a "location"; locations themselves), plus their OWN records
--   wherever they are. Managers see only team members who share a site with them
--   (people with no sites set stay visible).
-- Features = members.data.features, e.g. {"rota":false}; mirrored to pe_people.features.
--   A missing key = ON (today's behaviour). Owners, Admins and the Proview master have all.
--   Keep the keys in step with EMP_FEATURES in index.html:
--     timesheets  team clock-ins / timesheets (others' entries + approvals read)
--     approvals   approve or reopen timesheets (approvals write)
--     rota        rota: shifts, cover needs, rota settings (writes; others' shifts read)
--     tasks       tasks and task templates (incl. ticking off your own)
--     timeoff     team time off (others' leave requests)
--     reports     reports and exported files (exports)
--     documents   payslips and P45s for others (docs + files)
--     users       People: edit team profiles, send invites (members/secrets writes for others)
--     ai          Proview AI
--     live, settings  screen-only (pages hidden in the app; their data is shared/needed elsewhere)
-- Nobody can change their own role, sites or features; only Owners/Admins change anyone's.
-- =====================================================================

-- 1. Columns ------------------------------------------------------------
alter table public.pe_people  add column if not exists site_ids text[];
alter table public.pe_people  add column if not exists features jsonb not null default '{}'::jsonb;
alter table public.pe_invites add column if not exists site_ids text[];
alter table public.pe_invites add column if not exists features jsonb not null default '{}'::jsonb;

-- 2. Helpers ------------------------------------------------------------
create or replace function public.pe_jsonb_texts(j jsonb) returns text[]
language sql immutable set search_path = public as $$
  select case when jsonb_typeof(j) = 'array'
              then array(select x from jsonb_array_elements_text(j) x where coalesce(x,'') <> '') end
$$;

create or replace function public.pe_jsonb_features(j jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select case when jsonb_typeof(j) = 'object'
              then coalesce((select jsonb_object_agg(k, v) from jsonb_each(j) e(k, v) where jsonb_typeof(v) = 'boolean'), '{}'::jsonb)
              else '{}'::jsonb end
$$;

-- My sites in this business: null = every site (owners, admins, master, or nobody picked)
create or replace function public.pe_my_sites(o text) returns text[]
language sql stable security definer set search_path = public as $$
  select case when public.pe_is_admin(o) then null
    else (select case when cardinality(p.site_ids) > 0 then p.site_ids end
            from public.pe_people p where p.org_id = o and p.user_id = auth.uid()) end
$$;

-- Do I have this feature here? Missing key = yes. Owners/admins/master: always.
create or replace function public.pe_has_feature(o text, f text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when public.pe_is_admin(o) then true
    when public.pe_my_role(o) is null then false
    else coalesce((select case when jsonb_typeof(p.features -> f) = 'boolean' then (p.features ->> f)::boolean end
                     from public.pe_people p where p.org_id = o and p.user_id = auth.uid()), true)
  end
$$;

-- Is this location one of my sites? (no location = not site-linked)
create or replace function public.pe_site_ok(o text, loc text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(loc, '') = '' or (select s is null or loc = any(s) from (select public.pe_my_sites(o) s) x)
$$;

-- Does this person share a site with me? (people with no sites, and me, always do)
create or replace function public.pe_member_site_ok(o text, m text) returns boolean
language sql stable security definer set search_path = public as $$
  with mine as (select public.pe_my_sites(o) s)
  select (select s from mine) is null or coalesce(m, '') = '' or m = public.pe_my_member(o)
      or coalesce((select case when cardinality(t) > 0 then t && (select s from mine) end
                     from (select public.pe_jsonb_texts(r.data -> 'sites') t from public.pe_rows r
                            where r.org_id = o and r.coll = 'members' and r.id = m and not r.deleted) z), true)
$$;

-- Is this record inside my sites? Own records always are.
create or replace function public.pe_row_site_ok(o text, c text, rid text, m text, d jsonb) returns boolean
language sql stable security definer set search_path = public as $$
  select public.pe_my_sites(o) is null or case
    when c = 'locations' then public.pe_site_ok(o, rid)
    when c in ('entries','shifts','tasks','needs','taskTemplates')
      then (coalesce(m, '') <> '' and m = public.pe_my_member(o)) or public.pe_site_ok(o, d ->> 'location')
    else true end
$$;

-- Which feature does this read/write need? null = none. Own records stay open (clocking in, own leave, own payslips).
create or replace function public.pe_feat_ok(o text, c text, m text, w boolean) returns boolean
language sql stable security definer set search_path = public as $$
  select public.pe_is_admin(o) or b.f is null or public.pe_has_feature(o, b.f)
  from (select case
      when c = 'entries'   and a.others then 'timesheets'
      when c = 'approvals' then case when w then 'approvals' when a.others then 'timesheets' end
      when c = 'shifts'    and (w or a.others) then 'rota'
      when c in ('needs','rotaSettings') and w then 'rota'
      when c = 'tasks'     then 'tasks'
      when c = 'taskTemplates' and w then 'tasks'
      when c = 'requests'  and a.others then 'timeoff'
      when c = 'docs'      and a.others then 'documents'
      when c in ('members','secrets') and w and a.others then 'users'
      when c = 'exports'   then 'reports'
      when c = 'ai'        then 'ai'
    end as f
    from (select coalesce(m, '') = '' or m is distinct from public.pe_my_member(o) as others) a) b
$$;

-- 3. Existing rules, narrowed by site ------------------------------------
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
    and public.pe_member_site_ok(o, m)
$$;

create or replace function public.pe_can_see_time(o text, m text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.pe_can_see(o, m) or (public.pe_mgr_sees_all(o) and public.pe_member_site_ok(o, m))
$$;

-- 4. Read / write, now also by feature -----------------------------------
create or replace function public.pe_can_read(o text, c text, m text) returns boolean
language sql stable security definer set search_path = public as $$
  select (case public.pe_kind(c)
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
    else false end) and public.pe_feat_ok(o, c, m, false)
$$;

create or replace function public.pe_can_write(o text, c text, m text) returns boolean
language sql stable security definer set search_path = public as $$
  select (case public.pe_kind(c)
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
        else public.pe_can_see(o, m)
      end
    when 'admin' then
      case
        when c = 'notes'   then public.pe_my_role(o) in ('Owner','Admin','Manager')
        when c = 'audit'   then public.pe_in_org(o)
        when c = 'exports' then public.pe_is_admin(o) or m = public.pe_my_member(o)
        else public.pe_is_admin(o)
      end
    else false end) and public.pe_feat_ok(o, c, m, true)
$$;

alter policy "read rows" on public.pe_rows
  using (public.pe_can_read(org_id, coll, member_id) and public.pe_row_site_ok(org_id, coll, id, member_id, data));
alter policy "add rows" on public.pe_rows
  with check (public.pe_can_write(org_id, coll, member_id) and public.pe_row_site_ok(org_id, coll, id, member_id, data));
alter policy "change rows" on public.pe_rows
  using (public.pe_can_write(org_id, coll, member_id) and public.pe_row_site_ok(org_id, coll, id, member_id, data))
  with check (public.pe_can_write(org_id, coll, member_id) and public.pe_row_site_ok(org_id, coll, id, member_id, data));

-- 5. Who may change roles, sites and features -----------------------------
create or replace function public.pe_access_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  admin boolean;
  me    text;
  acc   boolean;
begin
  if new.coll <> 'members' or public.pe_is_master() then return new; end if;
  if new.data ? 'sites' and jsonb_typeof(new.data->'sites') not in ('array','null') then
    raise exception 'Sites must be a list';
  end if;
  if new.data ? 'features' and jsonb_typeof(new.data->'features') not in ('object','null') then
    raise exception 'Features must be a set of on/off switches';
  end if;
  admin := public.pe_is_admin(new.org_id);
  me := public.pe_my_member(new.org_id);
  if tg_op = 'UPDATE' then
    acc := (new.data->'sites') is distinct from (old.data->'sites')
        or (new.data->'features') is distinct from (old.data->'features');
    if new.id = me and (acc or (new.data->>'role') is distinct from (old.data->>'role')) then
      raise exception 'You can''t change your own role, sites or features. Ask another owner or admin.';
    end if;
    if acc and not admin then
      raise exception 'Only an owner or admin can change someone''s sites or features';
    end if;
  elsif not admin and (cardinality(public.pe_jsonb_texts(new.data->'sites')) > 0
                       or public.pe_jsonb_features(new.data->'features') <> '{}'::jsonb) then
    raise exception 'Only an owner or admin can set someone''s sites or features';
  end if;
  return new;
end $$;
create or replace trigger pe_access_check before insert or update on public.pe_rows
  for each row when (new.coll = 'members') execute function public.pe_access_check();

-- 6. Keep sign-ins and invites in step with the People record --------------
-- (separate triggers, so the existing pe_sync_role / pe_link_invites_for are unchanged)
create or replace function public.pe_sync_access() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.pe_people
     set site_ids = public.pe_jsonb_texts(new.data->'sites'),
         features = public.pe_jsonb_features(new.data->'features')
   where org_id = new.org_id and member_id = new.id
     and (site_ids, features) is distinct from (public.pe_jsonb_texts(new.data->'sites'), public.pe_jsonb_features(new.data->'features'));
  update public.pe_invites
     set site_ids = public.pe_jsonb_texts(new.data->'sites'),
         features = public.pe_jsonb_features(new.data->'features')
   where org_id = new.org_id and member_id = new.id
     and (site_ids, features) is distinct from (public.pe_jsonb_texts(new.data->'sites'), public.pe_jsonb_features(new.data->'features'));
  return null;
end $$;
create or replace trigger pe_sync_access after insert or update on public.pe_rows
  for each row when (new.coll = 'members') execute function public.pe_sync_access();

-- an invite / a new sign-in always carries the People record's sites/features (never what a client sent)
create or replace function public.pe_invites_fill() returns trigger
language plpgsql security definer set search_path = public as $$
declare d jsonb;
begin
  select r.data into d from public.pe_rows r where r.org_id = new.org_id and r.coll = 'members' and r.id = new.member_id and not r.deleted;
  new.site_ids := public.pe_jsonb_texts(d->'sites');
  new.features := public.pe_jsonb_features(d->'features');
  return new;
end $$;
create or replace trigger pe_invites_fill before insert or update on public.pe_invites
  for each row execute function public.pe_invites_fill();

create or replace function public.pe_people_fill() returns trigger
language plpgsql security definer set search_path = public as $$
declare d jsonb;
begin
  select r.data into d from public.pe_rows r where r.org_id = new.org_id and r.coll = 'members' and r.id = new.member_id and not r.deleted;
  new.site_ids := public.pe_jsonb_texts(d->'sites');
  new.features := public.pe_jsonb_features(d->'features');
  return new;
end $$;
create or replace trigger pe_people_fill before insert on public.pe_people
  for each row execute function public.pe_people_fill();

-- 7. Invites and files by feature -----------------------------------------
alter policy "send invites" on public.pe_invites
  with check (public.pe_can_manage(org_id, member_id) and public.pe_has_feature(org_id, 'users')
              and (role = 'Member' or (role in ('Manager','Admin') and public.pe_is_admin(org_id))
                   or (role = 'Owner' and public.pe_my_role(org_id) = 'Owner')));
alter policy "pe managers add files" on storage.objects
  with check (bucket_id = 'pe-files' and public.pe_can_manage(split_part(name,'/',1), split_part(name,'/',2))
              and public.pe_has_feature(split_part(name,'/',1), 'documents'));
alter policy "pe managers change files" on storage.objects
  using (bucket_id = 'pe-files' and public.pe_can_manage(split_part(name,'/',1), split_part(name,'/',2))
         and public.pe_has_feature(split_part(name,'/',1), 'documents'));
alter policy "pe managers remove files" on storage.objects
  using (bucket_id = 'pe-files' and public.pe_can_manage(split_part(name,'/',1), split_part(name,'/',2))
         and public.pe_has_feature(split_part(name,'/',1), 'documents'));

-- 8. Access ----------------------------------------------------------------
revoke execute on function public.pe_my_sites(text), public.pe_has_feature(text, text), public.pe_site_ok(text, text),
  public.pe_member_site_ok(text, text), public.pe_row_site_ok(text, text, text, text, jsonb),
  public.pe_feat_ok(text, text, text, boolean) from public, anon;
grant execute on function public.pe_my_sites(text), public.pe_has_feature(text, text), public.pe_site_ok(text, text),
  public.pe_member_site_ok(text, text), public.pe_row_site_ok(text, text, text, text, jsonb),
  public.pe_feat_ok(text, text, text, boolean) to authenticated;
revoke execute on function public.pe_access_check(), public.pe_invites_fill(), public.pe_sync_access(), public.pe_people_fill()
  from public, anon, authenticated;
