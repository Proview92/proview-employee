-- =====================================================================
--  002: team chat
--  Chat messages are ordinary pe_rows records with coll = 'chat':
--    id         message id
--    member_id  the author (always the person sending it)
--    data       { by, to, text, at }   to = 'all' (everyone) or a member id (direct message)
--  Everyone in the company reads 'all' messages; a direct message is read
--  only by its author and its recipient. Messages can't be edited, only
--  deleted by their author. Safe to re-run.
-- =====================================================================

drop policy if exists "read chat" on public.pe_rows;
create policy "read chat" on public.pe_rows for select to authenticated
  using (coll = 'chat' and public.pe_my_member(org_id) is not null
         and (coalesce(data->>'to','all') = 'all'
              or member_id = public.pe_my_member(org_id)
              or data->>'to' = public.pe_my_member(org_id)));

drop policy if exists "send chat" on public.pe_rows;
create policy "send chat" on public.pe_rows for insert to authenticated
  with check (coll = 'chat' and member_id is not null and member_id = public.pe_my_member(org_id));

drop policy if exists "change own chat" on public.pe_rows;
create policy "change own chat" on public.pe_rows for update to authenticated
  using (coll = 'chat' and member_id = public.pe_my_member(org_id))
  with check (coll = 'chat' and member_id = public.pe_my_member(org_id));

create or replace function public.pe_chat_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare me text := public.pe_my_member(new.org_id);
begin
  if new.coll <> 'chat' then return new; end if;
  if me is null or new.member_id is distinct from me or new.data->>'by' is distinct from me then
    raise exception 'Messages are sent as yourself';
  end if;
  if length(coalesce(new.data->>'text','')) > 4000 then
    raise exception 'That message is too long';
  end if;
  if tg_op = 'UPDATE' and new.data is distinct from old.data then
    raise exception 'Messages can''t be edited';
  end if;
  return new;
end $$;

drop trigger if exists pe_chat_check on public.pe_rows;
create trigger pe_chat_check before insert or update on public.pe_rows
  for each row execute function public.pe_chat_check();
