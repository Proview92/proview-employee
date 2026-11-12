-- 015: wording only (owner, 12 Nov 2026: "business", not "location"). Re-creates the guard from 014 with the new messages.
create or replace function public.pe_locations_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.coll <> 'locations' or coalesce(current_setting('pe.moving_locations', true), '') = '1' then return new; end if;
  if tg_op = 'INSERT' then
    -- an upsert of a location that exists is a change of its settings (below); a business's first location is fine
    if exists (select 1 from public.pe_rows x where x.org_id = new.org_id and x.coll = 'locations' and x.id = new.id) then
      if new.deleted and not (select deleted from public.pe_rows x where x.org_id = new.org_id and x.coll = 'locations' and x.id = new.id) then
        raise exception 'Locations can''t be deleted here. Proview links and unlinks businesses in the licence portal.';
      end if;
      return new;
    end if;
    if new.deleted then return new; end if;
    if exists (select 1 from public.pe_rows x where x.org_id = new.org_id and x.coll = 'locations' and not x.deleted) then
      raise exception 'Businesses are added in the licence portal (New business), and linked there by Proview.';
    end if;
    return new;
  end if;
  if (new.deleted and not old.deleted)
     or (coalesce((new.data->>'archived')::boolean, false) and not coalesce((old.data->>'archived')::boolean, false)) then
    raise exception 'Locations can''t be deleted here. Proview links and unlinks businesses in the licence portal.';
  end if;
  return new;
end $$;
