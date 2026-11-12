-- 014: Locations, not customers. Only the master links them (LOCATIONS_LINK_SPEC.md, owner 12 Nov 2026).
--
-- The licence portal's licence-hub is the only caller of two new hub actions (LOCATIONS_LINK_PROTOCOL.md):
--   hub_call(token, 'link',   { into: <org A>, from: <org B> })
--       -> { ok, account: A, from: B, moved_sites: ['loc/A/<loc>'...], already, renamed_units: [{kind, from, to}...] }
--   hub_call(token, 'unlink', { account: <org A>, site: 'loc/A/<loc>' | 'A/<loc>' | '<loc>' })
--       -> { ok, account: <new org>, from: A, site: 'loc/<new org>/<loc>', already, renamed_units: [...] }
--
-- link merges business B into A in one transaction. Employee keeps everything as JSON rows per business (pe_rows), so:
--   * every B row moves to A. An id that A already uses in the same collection (e.g. both have location 'l1') gets a
--     new id ('l1_x3f9'), and every reference to it inside B's rows is rewritten (entries' location, members' sites,
--     schedules' locations ...), as are pe_people / pe_invites / pe_licences / pe_location_licences.
--   * the same person in both (same login, or the same email on the member record) becomes one member: A's record,
--     with the higher role (Owner > Admin > Manager > Member); B's time entries, shifts, requests ... are re-pointed
--     to it. Owners, admins and managers see every location of the merged business; staff keep the locations they had
--     (staff with "all locations" keep their own side's locations).
--   * B's own settings rows that A has too (org, settings, setup, rotaSettings) give way to A's. B's team chat can
--     only be written by its author, so it is kept in the log (hub_private.location_moves.details) instead.
--   * location licences and staff add-on licences move with their location / person; nothing is changed.
--   * B's business row is deleted once empty. Unit ids contain the org id, so the answer lists renamed_units for the
--     portal: 'loc/B/<l>' -> 'loc/A/<l'>' and 'B/<m>' -> 'A/<m'>'.
-- unlink moves one location into a new business named after it: the location, its licence and its time entries,
-- shifts, tasks, needs and task templates move; settings, groups, activities, projects, clients, schedules,
-- policies and calendars are copied; members who can see it are copied (same ids, same role, restriction reduced to
-- that location) with their logins and pending invites. In A, staff who only had that location are archived.
-- Leave requests, documents, approvals and staff add-on licences stay with A.
-- Both run as this app's master for the one call (as hub 'trial' / 'add_business' do), so the row checks let the
-- moves through; a session flag lets only these two functions add or remove a location.
--
-- Adding and deleting a location: nobody (master included) adds, deletes or archives a location from the app any
-- more (pe_locations_guard). A business's first location is still made by the self sign-up (pe_start_trial) and by
-- Add business (pe_add_business / hub add_business). Renaming and other location settings are unchanged.
-- Every other hub action is exactly the live hub_call, moved to hub_private.hub_call_pre_link.
-- Safe to run more than once. Apply after 013.

create table if not exists hub_private.location_moves (
  id           bigserial primary key,
  at           timestamptz not null default now(),
  action       text not null check (action in ('link', 'unlink')),
  from_account text not null,
  into_account text not null,
  site         text,
  sites        text[] not null default '{}',
  renamed      jsonb not null default '[]'::jsonb,
  details      jsonb not null default '{}'::jsonb
);
create index if not exists location_moves_from on hub_private.location_moves (from_account);

-- 0) documents stay where they were uploaded ('<org>/<member>/...'); after a link the folder belongs to A's member
create table if not exists public.pe_file_moves (
  old_prefix text primary key,          -- '<old org>/<old member>'
  org_id     text not null references public.pe_orgs(id) on delete cascade,
  member_id  text not null,
  moved_at   timestamptz not null default now()
);
alter table public.pe_file_moves enable row level security;   -- no policies: read by the functions below only
revoke all on public.pe_file_moves from anon, authenticated;
create or replace function public.pe_file_org(p_name text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select f.org_id from public.pe_file_moves f where f.old_prefix = split_part(p_name, '/', 1) || '/' || split_part(p_name, '/', 2)),
                  split_part(p_name, '/', 1)) $$;
create or replace function public.pe_file_member(p_name text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select f.member_id from public.pe_file_moves f where f.old_prefix = split_part(p_name, '/', 1) || '/' || split_part(p_name, '/', 2)),
                  split_part(p_name, '/', 2)) $$;
alter policy "pe read own files" on storage.objects
  using (bucket_id = 'pe-files' and public.pe_can_see(public.pe_file_org(name), public.pe_file_member(name)));
alter policy "pe managers change files" on storage.objects
  using (bucket_id = 'pe-files' and public.pe_can_manage(public.pe_file_org(name), public.pe_file_member(name))
         and public.pe_has_feature(public.pe_file_org(name), 'documents'));
alter policy "pe managers remove files" on storage.objects
  using (bucket_id = 'pe-files' and public.pe_can_manage(public.pe_file_org(name), public.pe_file_member(name))
         and public.pe_has_feature(public.pe_file_org(name), 'documents'));
-- (new uploads keep going to '<org>/<member>/...', so "pe managers add files" is unchanged)

create or replace function public.pe_master_delete_org(o text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.pe_is_master() then raise exception 'Only the master admin can delete businesses.'; end if;
  begin
    delete from storage.objects where bucket_id = 'pe-files' and (split_part(name, '/', 1) = o
      or split_part(name, '/', 1) || '/' || split_part(name, '/', 2) in (select old_prefix from public.pe_file_moves where org_id = o));
  exception when others then null;
  end;
  delete from public.pe_orgs where id = o;
end $$;

-- 1) no adding, deleting or archiving a location from the app
create or replace function public.pe_locations_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.coll <> 'locations' or coalesce(current_setting('pe.moving_locations', true), '') = '1' then return new; end if;
  if tg_op = 'INSERT' then
    -- an upsert of a location that exists is a change of its settings (below); a business's first location is fine
    if exists (select 1 from public.pe_rows x where x.org_id = new.org_id and x.coll = 'locations' and x.id = new.id) then
      if new.deleted and not (select deleted from public.pe_rows x where x.org_id = new.org_id and x.coll = 'locations' and x.id = new.id) then
        raise exception 'Locations can''t be deleted here. Proview links and unlinks locations in the licence portal.';
      end if;
      return new;
    end if;
    if new.deleted then return new; end if;
    if exists (select 1 from public.pe_rows x where x.org_id = new.org_id and x.coll = 'locations' and not x.deleted) then
      raise exception 'Locations can''t be added here. To link another location, call Proview on 020 8935 5495.';
    end if;
    return new;
  end if;
  if (new.deleted and not old.deleted)
     or (coalesce((new.data->>'archived')::boolean, false) and not coalesce((old.data->>'archived')::boolean, false)) then
    raise exception 'Locations can''t be deleted here. Proview links and unlinks locations in the licence portal.';
  end if;
  return new;
end $$;
drop trigger if exists pe_locations_guard on public.pe_rows;
create trigger pe_locations_guard before insert or update on public.pe_rows
  for each row when (new.coll = 'locations') execute function public.pe_locations_guard();

-- 2) helpers
create or replace function hub_private.pe_role_rank(r text) returns int language sql immutable as $$
  select case r when 'Owner' then 4 when 'Admin' then 3 when 'Manager' then 2 else 1 end $$;
-- rewrite every JSON string equal to a key of p_map (old id -> new id) inside p
create or replace function hub_private.pe_remap(p jsonb, p_map jsonb) returns jsonb
language plpgsql immutable as $$
declare k text; t text;
begin
  if p is null or p_map is null or p_map = '{}'::jsonb then return p; end if;
  t := p::text;
  for k in select jsonb_object_keys(p_map) loop
    t := replace(t, to_jsonb(k)::text, to_jsonb(p_map->>k)::text);
  end loop;
  return t::jsonb;
end $$;
create or replace function hub_private.pe_sites_of(p_data jsonb) returns text[] language sql immutable as $$
  select coalesce((select array_agg(x) from jsonb_array_elements_text(case when jsonb_typeof(p_data->'sites') = 'array' then p_data->'sites' else '[]'::jsonb end) x), '{}') $$;

-- 3) link: B into A
create or replace function hub_private.pe_link_orgs(p_into text, p_from text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  a public.pe_orgs; b public.pe_orgs; lg hub_private.location_moves;
  person jsonb := '{}';    -- B member id -> A member id (the same person)
  ren jsonb := '{}';       -- B id -> new id, for ids A already uses (per collection, applied to all of B's rows)
  memmap jsonb := '{}';    -- B member id -> member id in A (person merge or rename or same)
  a_locs text[]; b_locs text[]; all_locs text[]; r record; nid text; renamed jsonb := '[]'; moved text[];
  am public.pe_rows; nrole text; nsites jsonb; chat jsonb;
  singletons constant text[] := array['org', 'settings', 'setup', 'rotaSettings'];
begin
  if p_into = p_from then raise exception 'An account can''t be linked to itself.'; end if;
  select * into a from public.pe_orgs where id = p_into for update;
  if not found then raise exception 'Account not found: %', p_into; end if;
  select * into b from public.pe_orgs where id = p_from for update;
  if not found then
    select * into lg from hub_private.location_moves where action = 'link' and from_account = p_from order by id desc limit 1;
    if lg.id is null then raise exception 'Account not found: %', p_from; end if;
    if lg.into_account <> p_into and not exists (select 1 from hub_private.location_moves l2 where l2.action = 'link'
                                                  and l2.from_account = lg.into_account and l2.into_account = p_into) then
      raise exception '% was already linked into %, not %.', p_from, lg.into_account, p_into;
    end if;
    return jsonb_build_object('ok', true, 'account', p_into, 'from', p_from, 'already', true,
      'moved_sites', coalesce((select jsonb_agg('loc/' || lg.into_account || '/' || x) from unnest(lg.sites) x), '[]'::jsonb),
      'renamed_units', lg.renamed);
  end if;
  perform set_config('pe.moving_locations', '1', true);

  -- the same person: same login, else the same email on both member records
  for r in select bm.id bid, am2.id aid
             from public.pe_rows bm join public.pe_rows am2 on am2.org_id = a.id and am2.coll = 'members' and not am2.deleted
            where bm.org_id = b.id and bm.coll = 'members' and not bm.deleted
              and (exists (select 1 from public.pe_people pb join public.pe_people pa on pa.user_id = pb.user_id
                            where pb.org_id = b.id and pb.member_id = bm.id and pa.org_id = a.id and pa.member_id = am2.id)
                   or (nullif(lower(trim(bm.data->>'email')), '') is not null and lower(trim(bm.data->>'email')) = lower(trim(am2.data->>'email')))) loop
    if not person ? r.bid and not exists (select 1 from jsonb_each_text(person) e where e.value = r.aid) then
      person := person || jsonb_build_object(r.bid, r.aid);
    end if;
  end loop;
  -- ids A already uses (same collection): a new id for B's
  for r in select x.coll, x.id from public.pe_rows x
            where x.org_id = b.id and not (x.coll = any(singletons))
              and not (x.coll in ('members', 'secrets') and person ? x.id)
              and exists (select 1 from public.pe_rows y where y.org_id = a.id and y.coll = x.coll and y.id = x.id) loop
    if not ren ? r.id then
      nid := r.id || '_' || substr(md5(b.id || '/' || r.id), 1, 4);
      while exists (select 1 from public.pe_rows y where y.org_id in (a.id, b.id) and y.id = nid) loop
        nid := r.id || '_' || substr(md5(nid || random()::text), 1, 4);
      end loop;
      ren := ren || jsonb_build_object(r.id, nid);
    end if;
  end loop;
  -- member ids of B as they will be in A
  for r in select id from public.pe_rows where org_id = b.id and coll = 'members' loop
    memmap := memmap || jsonb_build_object(r.id, coalesce(person->>r.id, ren->>r.id, r.id));
  end loop;

  select coalesce(array_agg(id order by id), '{}') into a_locs from public.pe_rows where org_id = a.id and coll = 'locations' and not deleted;
  select coalesce(array_agg(coalesce(ren->>id, id) order by id), '{}') into b_locs from public.pe_rows where org_id = b.id and coll = 'locations' and not deleted;
  all_locs := a_locs || b_locs;

  -- A's staff with "all locations" keep A's locations; A's managers see all of them
  update public.pe_rows set data = jsonb_set(data, '{sites}', to_jsonb(a_locs))
   where org_id = a.id and coll = 'members' and coalesce(data->>'role', 'Member') = 'Member'
     and cardinality(hub_private.pe_sites_of(data)) = 0 and cardinality(a_locs) > 0;
  update public.pe_rows set data = jsonb_set(data, '{sites}', '[]'::jsonb)
   where org_id = a.id and coll = 'members' and data->>'role' = 'Manager' and cardinality(hub_private.pe_sites_of(data)) > 0;

  -- the same person: one member record in A, with the higher role
  for r in select e.key bid, e.value aid from jsonb_each_text(person) e loop
    select * into am from public.pe_rows where org_id = a.id and coll = 'members' and id = r.aid;
    select coalesce(x.data->>'role', 'Member') into nrole from public.pe_rows x where x.org_id = b.id and x.coll = 'members' and x.id = r.bid;
    if hub_private.pe_role_rank(nrole) < hub_private.pe_role_rank(coalesce(am.data->>'role', 'Member')) then nrole := coalesce(am.data->>'role', 'Member'); end if;
    if nrole in ('Owner', 'Admin', 'Manager') then nsites := '[]'::jsonb;
    else nsites := to_jsonb(array(select distinct x from unnest(
           case when cardinality(hub_private.pe_sites_of(am.data)) = 0 then a_locs else hub_private.pe_sites_of(am.data) end
        || coalesce((select case when cardinality(hub_private.pe_sites_of(x.data)) = 0 then b_locs
                                 else array(select coalesce(ren->>s, s) from unnest(hub_private.pe_sites_of(x.data)) s) end
                       from public.pe_rows x where x.org_id = b.id and x.coll = 'members' and x.id = r.bid), '{}')) x));
    end if;
    update public.pe_rows set data = data || jsonb_build_object('role', nrole, 'sites', nsites) where org_id = a.id and coll = 'members' and id = r.aid;
    -- B's copy of that person (and their secrets row) gives way to A's; their records follow the remap below
    delete from public.pe_rows where org_id = b.id and coll in ('members', 'secrets') and id = r.bid;
    -- a staff add-on bought in B is kept when A has none
    if not exists (select 1 from public.pe_licences where org_id = a.id and member_id = r.aid and license_type is not null) then
      delete from public.pe_licences where org_id = a.id and member_id = r.aid;
      update public.pe_licences set member_id = r.aid where org_id = b.id and member_id = r.bid;
    end if;
    delete from public.pe_people where org_id = b.id and member_id = r.bid;
    delete from public.pe_invites where org_id = b.id and member_id = r.bid;
  end loop;
  -- B's other managers / owners / admins see every location; B's staff with "all locations" keep B's
  update public.pe_rows set data = jsonb_set(data, '{sites}',
           case when coalesce(data->>'role', 'Member') in ('Owner', 'Admin', 'Manager') then '[]'::jsonb
                when cardinality(hub_private.pe_sites_of(data)) = 0 then to_jsonb(b_locs) else data->'sites' end)
   where org_id = b.id and coll = 'members';

  -- B's settings rows that A has too give way to A's
  -- team chat can only be written as its author, so B's messages are kept in the log instead of moved
  select coalesce(jsonb_agg(to_jsonb(x) - 'org_id'), '[]'::jsonb) into chat from public.pe_rows x where x.org_id = b.id and x.coll = 'chat';
  delete from public.pe_rows where org_id = b.id and coll = 'chat';
  delete from public.pe_rows x where x.org_id = b.id and x.coll = any(singletons)
     and exists (select 1 from public.pe_rows y where y.org_id = a.id and y.coll = x.coll and y.id = x.id);
  -- every remaining B row: ids rewritten, then moved to A
  update public.pe_rows set data = hub_private.pe_remap(data, person || ren),
         id = case when coll in ('members', 'secrets') then coalesce(memmap->>id, id) else coalesce(ren->>id, id) end,
         member_id = case when member_id is null then null else coalesce(memmap->>member_id, member_id) end
   where org_id = b.id;
  update public.pe_rows set org_id = a.id where org_id = b.id;

  update public.pe_people set org_id = a.id, member_id = coalesce(memmap->>member_id, member_id) where org_id = b.id;
  update public.pe_people p set site_ids = public.pe_jsonb_texts(r2.data->'sites'), features = public.pe_jsonb_features(r2.data->'features')
    from public.pe_rows r2 where p.org_id = a.id and r2.org_id = a.id and r2.coll = 'members' and r2.id = p.member_id;
  update public.pe_invites set org_id = a.id, member_id = coalesce(memmap->>member_id, member_id) where org_id = b.id;
  update public.pe_licences set org_id = a.id, member_id = coalesce(memmap->>member_id, member_id) where org_id = b.id;
  update public.pe_location_licences set org_id = a.id, location_id = coalesce(ren->>location_id, location_id) where org_id = b.id;
  insert into public.pe_trials (org_id, who, used_at) select a.id, who, used_at from public.pe_trials where org_id = b.id on conflict do nothing;
  update public.pe_trial_emails set org_id = a.id where org_id = b.id;
  insert into public.pe_org_notes (org_id, notes, updated_at)
    select a.id, 'From ' || b.name || ': ' || n.notes, now() from public.pe_org_notes n where n.org_id = b.id and nullif(trim(n.notes), '') is not null
  on conflict (org_id) do update set notes = concat_ws(E'\n\n', public.pe_org_notes.notes, excluded.notes), updated_at = now();
  -- documents uploaded in B
  insert into public.pe_file_moves (old_prefix, org_id, member_id)
    select b.id || '/' || e.key, a.id, e.value from jsonb_each_text(memmap) e
  on conflict (old_prefix) do update set org_id = excluded.org_id, member_id = excluded.member_id, moved_at = now();
  update public.pe_file_moves set org_id = a.id, member_id = coalesce(memmap->>member_id, member_id) where org_id = b.id;

  -- what the portal must re-point
  select coalesce(array_agg(x order by x), '{}') into moved from unnest(b_locs) x;
  renamed := coalesce((select jsonb_agg(jsonb_build_object('kind', 'location', 'from', 'loc/' || b.id || '/' || k.old, 'to', 'loc/' || a.id || '/' || k.new))
                         from (select l.id as new, coalesce((select e.key from jsonb_each_text(ren) e where e.value = l.id), l.id) as old
                                 from unnest(b_locs) l(id)) k), '[]'::jsonb)
          || coalesce((select jsonb_agg(jsonb_build_object('kind', 'staff', 'from', b.id || '/' || e.key, 'to', a.id || '/' || e.value))
                         from jsonb_each_text(memmap) e), '[]'::jsonb);

  insert into hub_private.location_moves (action, from_account, into_account, sites, renamed, details)
  values ('link', b.id, a.id, moved, renamed, jsonb_build_object('from_name', b.name, 'into_name', a.name,
          'same_person', person, 'renamed_ids', ren, 'from_contact_email', b.contact_email, 'chat', chat));
  delete from public.pe_orgs where id = b.id;
  perform set_config('pe.moving_locations', '', true);
  return jsonb_build_object('ok', true, 'account', a.id, 'from', b.id, 'already', false,
    'moved_sites', coalesce((select jsonb_agg('loc/' || a.id || '/' || x) from unnest(moved) x), '[]'::jsonb), 'renamed_units', renamed);
end $$;
revoke all on function hub_private.pe_link_orgs(text, text) from public, anon, authenticated;

-- 4) unlink: one location of A into a new business
create or replace function hub_private.pe_unlink_location(p_account text, p_loc text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  a public.pe_orgs; lr public.pe_rows; n_id text; lg hub_private.location_moves; nlocs int; lname text;
  copied text[]; ren jsonb;
  shared_copy constant text[] := array['org', 'settings', 'setup', 'groups', 'activities', 'projects', 'clients', 'schedules',
                                       'policies', 'calendars', 'rotaSettings'];
  at_location constant text[] := array['entries', 'shifts', 'tasks', 'needs', 'taskTemplates'];
begin
  select * into a from public.pe_orgs where id = p_account for update;
  select * into lr from public.pe_rows where org_id = p_account and coll = 'locations' and id = p_loc and not deleted for update;
  if lr.org_id is null then
    select * into lg from hub_private.location_moves where action = 'unlink' and from_account = p_account and site = p_loc
     order by id desc limit 1;
    if lg.id is not null and exists (select 1 from public.pe_rows where org_id = lg.into_account and coll = 'locations' and id = p_loc and not deleted) then
      return jsonb_build_object('ok', true, 'account', lg.into_account, 'from', p_account, 'site', 'loc/' || lg.into_account || '/' || p_loc,
                                'already', true, 'renamed_units', lg.renamed);
    end if;
    if a.id is null then raise exception 'Account not found: %', p_account; end if;
    if exists (select 1 from public.pe_rows where coll = 'locations' and id = p_loc and not deleted) then
      raise exception 'That location is not in account %.', p_account;
    end if;
    raise exception 'Location not found: loc/%/%', p_account, p_loc;
  end if;
  select count(*) into nlocs from public.pe_rows where org_id = a.id and coll = 'locations' and not deleted;
  if nlocs <= 1 then raise exception '% has only that one location, so there is nothing to unlink.', a.name; end if;
  lname := coalesce(nullif(trim(lr.data->>'name'), ''), a.name);
  perform set_config('pe.moving_locations', '1', true);

  insert into public.pe_orgs (name, created_by, contact_email, self_signup, staff_follow_owner, suspended)
  values (lname, null, a.contact_email, false, false, a.suspended) returning id into n_id;

  -- who comes along: everyone who can see the location, and anyone whose records there move with it
  select coalesce(array_agg(m.id), '{}') into copied from public.pe_rows m
   where m.org_id = a.id and m.coll = 'members' and not m.deleted
     and (coalesce(m.data->>'role', 'Member') in ('Owner', 'Admin')
          or cardinality(hub_private.pe_sites_of(m.data)) = 0 or p_loc = any(hub_private.pe_sites_of(m.data))
          or exists (select 1 from public.pe_rows x where x.org_id = a.id and x.coll = any(at_location)
                      and x.data->>'location' = p_loc and x.member_id = m.id));

  -- settings and shared lists are copied; the org row gets the new name
  insert into public.pe_rows (org_id, coll, id, member_id, data, deleted)
    select n_id, x.coll, x.id, x.member_id,
           case when x.coll = 'org' then x.data || jsonb_build_object('name', lname) else x.data end, x.deleted
      from public.pe_rows x
     where x.org_id = a.id and (x.coll = any(shared_copy)
            or (x.coll in ('needs', 'taskTemplates') and nullif(x.data->>'location', '') is null));
  -- members (same ids) and their secrets rows
  insert into public.pe_rows (org_id, coll, id, member_id, data, deleted)
    select n_id, x.coll, x.id, x.member_id,
           case when x.coll <> 'members' then x.data
                when coalesce(x.data->>'role', 'Member') in ('Owner', 'Admin') or cardinality(hub_private.pe_sites_of(x.data)) = 0
                  then x.data || jsonb_build_object('sites', '[]'::jsonb)
                when p_loc = any(hub_private.pe_sites_of(x.data)) then x.data || jsonb_build_object('sites', jsonb_build_array(p_loc))
                else x.data || jsonb_build_object('sites', jsonb_build_array(p_loc), 'archived', true) end, x.deleted
      from public.pe_rows x where x.org_id = a.id and x.coll in ('members', 'secrets') and x.id = any(copied);
  insert into public.pe_people (org_id, user_id, member_id, role, email, created_at)
    select n_id, p.user_id, p.member_id, p.role, p.email, p.created_at from public.pe_people p
     where p.org_id = a.id and p.member_id = any(copied)
       and not coalesce((select (x.data->>'archived')::boolean from public.pe_rows x where x.org_id = n_id and x.coll = 'members' and x.id = p.member_id), false);
  insert into public.pe_invites (org_id, email, member_id, role, invited_by, created_at)
    select n_id, i.email, i.member_id, i.role, i.invited_by, i.created_at from public.pe_invites i
     where i.org_id = a.id and i.member_id = any(copied) on conflict do nothing;
  -- the location itself, its licence and everything recorded at it move
  update public.pe_rows set org_id = n_id where org_id = a.id and coll = 'locations' and id = p_loc;
  update public.pe_rows set org_id = n_id where org_id = a.id and coll = any(at_location) and data->>'location' = p_loc;
  update public.pe_location_licences set org_id = n_id where org_id = a.id and location_id = p_loc;
  -- in A: nobody keeps that location; staff who had only it are archived there
  update public.pe_rows set data = data || jsonb_build_object('archived', true)
   where org_id = a.id and coll = 'members' and coalesce(data->>'role', 'Member') not in ('Owner', 'Admin')
     and hub_private.pe_sites_of(data) = array[p_loc];
  update public.pe_rows set data = jsonb_set(data, '{sites}', to_jsonb(array_remove(hub_private.pe_sites_of(data), p_loc)))
   where org_id = a.id and coll in ('members') and p_loc = any(hub_private.pe_sites_of(data)) and hub_private.pe_sites_of(data) <> array[p_loc];
  update public.pe_rows set data = jsonb_set(data, '{locations}', coalesce((select jsonb_agg(v) from jsonb_array_elements(data->'locations') v where v <> to_jsonb(p_loc)), '[]'::jsonb))
   where org_id = a.id and coll in ('schedules', 'projects') and jsonb_typeof(data->'locations') = 'array' and data->'locations' ? p_loc;
  update public.pe_people p set site_ids = public.pe_jsonb_texts(r2.data->'sites'), features = public.pe_jsonb_features(r2.data->'features')
    from public.pe_rows r2 where p.org_id = n_id and r2.org_id = n_id and r2.coll = 'members' and r2.id = p.member_id;

  ren := jsonb_build_array(jsonb_build_object('kind', 'location', 'from', 'loc/' || a.id || '/' || p_loc, 'to', 'loc/' || n_id || '/' || p_loc));
  insert into hub_private.location_moves (action, from_account, into_account, site, sites, renamed, details)
  values ('unlink', a.id, n_id, p_loc, array[p_loc], ren, jsonb_build_object('from_name', a.name, 'site_name', lname, 'members', cardinality(copied)));
  perform set_config('pe.moving_locations', '', true);
  return jsonb_build_object('ok', true, 'account', n_id, 'from', a.id, 'site', 'loc/' || n_id || '/' || p_loc,
                            'already', false, 'renamed_units', ren, 'members', cardinality(copied));
end $$;
revoke all on function hub_private.pe_unlink_location(text, text) from public, anon, authenticated;

-- 5) Move the live hub_call aside, untouched, as hub_private.hub_call_pre_link (not callable by the API).
do $$
declare src text := (select prosrc from pg_proc where oid = to_regprocedure('public.hub_call(text,text,jsonb)'));
begin
  if src is null then raise exception 'public.hub_call(text,text,jsonb) is missing.'; end if;
  if position('hub_private.hub_call_pre_link' in src) = 0 then
    drop function if exists hub_private.hub_call_pre_link(text, text, jsonb);
    alter function public.hub_call(text, text, jsonb) rename to hub_call_pre_link;
    alter function public.hub_call_pre_link(text, text, jsonb) set schema hub_private;
  end if;
end $$;
revoke all on function hub_private.hub_call_pre_link(text, text, jsonb) from public, anon, authenticated;

-- 6) hub_call: 'link' and 'unlink' here (run as this app's master for the one call), every other action as before.
create or replace function public.hub_call(p_token text, p_action text, p_args jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  r jsonb; mu uuid; me text; a text; b text; s text; loc text;
  c_claims text := current_setting('request.jwt.claims', true);
  c_sub    text := current_setting('request.jwt.claim.sub', true);
  c_claim  text := current_setting('request.jwt.claim', true);
begin
  if p_action is distinct from 'link' and p_action is distinct from 'unlink' then
    return hub_private.hub_call_pre_link(p_token, p_action, p_args);
  end if;
  if p_token is null or encode(extensions.digest(p_token, 'sha256'), 'hex') is distinct from (select token_sha256 from hub_private.config where id = 1) then
    raise exception 'not authorised';
  end if;
  if p_action = 'link' then
    a := nullif(trim(coalesce(p_args->>'into', '')), ''); b := nullif(trim(coalesce(p_args->>'from', '')), '');
    if a is null or b is null then raise exception 'Say which accounts to link (into and from).'; end if;
  else
    a := nullif(trim(coalesce(p_args->>'account', '')), ''); s := trim(coalesce(p_args->>'site', ''));
    if a is null or s = '' then raise exception 'Say which account and location to unlink.'; end if;
    if s like 'loc/%' then s := substr(s, 5); end if;
    loc := case when s like a || '/%' then substr(s, length(a) + 2) when position('/' in s) > 0 then null else s end;
    if loc is null or loc = '' then raise exception 'Location not found: %', p_args->>'site'; end if;
  end if;

  select m.user_id, lower(u.email) into mu, me from public.pe_masters m join auth.users u on u.id = m.user_id
   order by u.created_at limit 1;
  if mu is null then raise exception 'This app has no Proview master account to move locations with.'; end if;
  perform set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('sub', mu, 'email', me, 'role', 'authenticated',
                     'aud', 'authenticated', 'is_anonymous', false))::text, true);
  perform set_config('request.jwt.claim.sub', mu::text, true);
  perform set_config('request.jwt.claim', '', true);
  if p_action = 'link' then r := hub_private.pe_link_orgs(a, b); else r := hub_private.pe_unlink_location(a, loc); end if;
  perform set_config('request.jwt.claims', coalesce(c_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(c_sub, ''), true);
  perform set_config('request.jwt.claim', coalesce(c_claim, ''), true);
  return r;
end $$;
revoke all on function public.hub_call(text, text, jsonb) from public;
grant execute on function public.hub_call(text, text, jsonb) to anon, authenticated;
