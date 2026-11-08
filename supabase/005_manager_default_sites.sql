-- Note: today only owners/admins can add people (RLS: pe_can_manage needs an existing member row), so this is a backstop.
-- People added by a site-limited manager get that manager's sites (instead of none = visible everywhere).
-- A site-limited manager may pick fewer of their own sites, never other sites. Features stay owner/admin only.
create or replace function public.pe_access_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  admin boolean;
  me    text;
  acc   boolean;
  mine  text[];
  want  text[];
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
  elsif not admin then
    if public.pe_jsonb_features(new.data->'features') <> '{}'::jsonb then
      raise exception 'Only an owner or admin can set someone''s features';
    end if;
    mine := public.pe_my_sites(new.org_id);          -- null = all sites
    want := public.pe_jsonb_texts(new.data->'sites');
    if mine is not null then
      if cardinality(want) = 0 then
        new.data := jsonb_set(new.data, '{sites}', to_jsonb(mine));
      elsif not (want <@ mine) then
        raise exception 'You can only add people to your own sites';
      end if;
    elsif cardinality(want) > 0 then
      raise exception 'Only an owner or admin can set someone''s sites';
    end if;
  end if;
  return new;
end $$;
