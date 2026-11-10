-- 008: "+ Add business" on the Locations page (ADD_BUSINESS_SPEC, 10 Nov 2026), as Proview Signage
-- (signage migration 038, add_business / add_user).
--
-- pe_add_business (Proview master only), all-or-nothing:
--   1. the business (pe_orgs, added by Proview: self_signup = false), its 'org' record and one location
--      ('locations' record) with the same name;
--   2. the owner login:
--      - new email: a ready-to-use login (email confirmed, password set, name and mobile kept), no email sent;
--      - email that already has a login: NOT touched, their password stays;
--   3. that person's member record (role Owner, name, email, mobile as phone) and pe_people row (Owner).
-- Licences: the existing rules. The pe_member_trial / pe_org_owner_trial triggers give the owner the usual
-- 3-day 'trial3' licence. The business has no pe_trial_emails row (it wasn't a self-signup), so as for every
-- business Proview adds (pe_master_create_org), staff added later get their own 3-day trial (migration 007).
-- Extend licences in the licence portal. Any error (bad email, short password, not the master...) undoes it all.
-- The older pe_master_create_org (invite only) is left as it is.

create or replace function public.pe_add_business(p_business text, p_name text, p_email text, p_mobile text, p_password text)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  bn  text := trim(coalesce(p_business, ''));
  nm  text := trim(coalesce(p_name, ''));
  em  text := lower(trim(coalesce(p_email, '')));
  mob text := nullif(left(trim(coalesce(p_mobile, '')), 40), '');
  o text; m text := 'm' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
  loc text := 'l' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
  uid uuid; existing boolean := false;
begin
  if not public.pe_is_master() then raise exception 'Only the master admin can add businesses.'; end if;
  if length(bn) < 2 then raise exception 'Enter the business name.'; end if;
  if length(bn) > 120 then raise exception 'That business name is too long.'; end if;
  if length(nm) < 2 then raise exception 'Enter the owner''s name.'; end if;
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address.'; end if;

  -- the owner login
  select id into uid from auth.users where lower(email) = em and not coalesce(is_anonymous, false) order by created_at limit 1;
  if uid is not null then
    existing := true;   -- already has a login: never touch their password
  else
    if length(coalesce(p_password, '')) < 6 then raise exception 'The password needs at least 6 characters.'; end if;
    uid := gen_random_uuid();
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, recovery_token, email_change, email_change_token_new)
    values (uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', em,
            extensions.crypt(p_password, extensions.gen_salt('bf', 10)), now(),
            '{"provider":"email","providers":["email"]}'::jsonb,
            jsonb_strip_nulls(jsonb_build_object('name', nm, 'full_name', nm, 'mobile', mob)), now(), now(), '', '', '', '');
    insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), uid, uid::text, 'email',
            jsonb_build_object('sub', uid::text, 'email', em, 'email_verified', true, 'phone_verified', false), now(), now(), now());
  end if;

  -- the business, its details and its location
  insert into public.pe_orgs (name, contact_email, self_signup) values (bn, em, false) returning id into o;
  insert into public.pe_rows (org_id, coll, id, data)
  values (o, 'org', 'org', jsonb_build_object('name', bn, 'email', em));
  insert into public.pe_rows (org_id, coll, id, member_id, data, deleted)
  values (o, 'locations', loc, null,
          jsonb_build_object('id', loc, 'name', bn, 'address', '', 'lat', 51.5072, 'lng', -0.1276, 'radius', 150, 'archived', false), false);

  -- the owner: member record first (pe_people_fill reads it), then the login's place in the business
  insert into public.pe_rows (org_id, coll, id, member_id, data)
  values (o, 'members', m, m, jsonb_build_object('id', m, 'name', nm, 'role', 'Owner', 'email', em, 'phone', coalesce(mob, ''),
          'group', '', 'archived', false, 'color', '#4a6cd0',
          'joined', to_char(now() at time zone 'Europe/London', 'YYYY-MM-DD')));
  insert into public.pe_people (org_id, user_id, member_id, role, email) values (o, uid, m, 'Owner', em);

  return jsonb_build_object('org_id', o, 'location_id', loc, 'member_id', m, 'user_id', uid, 'email', em, 'existing', existing);
end;
$$;
revoke all on function public.pe_add_business(text, text, text, text, text) from public, anon;
grant execute on function public.pe_add_business(text, text, text, text, text) to authenticated;
