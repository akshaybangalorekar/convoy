-- Retained join requests, the one thing MQTT's broker used to hold for us.
--
-- On MQTT a request was published with retain=true on its own topic, and the broker handed
-- it to any pin phone that connected later. Here it is a row: it survives a broker restart,
-- it can be read a week later, and the pin phone that was closed all weekend still finds it.
create table if not exists public.asks (
  id    text primary key,          -- the asking phone's member id
  body  text not null default '',
  at    timestamptz not null default now()
);

create index if not exists asks_at on public.asks (at desc);

alter table public.asks enable row level security;

-- Anyone signed in may leave a request, read the fresh ones, and take their own back.
-- Nothing here is secret: it is a name and a timestamp.
drop policy if exists asks_read on public.asks;
create policy asks_read on public.asks
  for select to authenticated using (true);

drop policy if exists asks_write on public.asks;
create policy asks_write on public.asks
  for insert to authenticated with check (true);

drop policy if exists asks_update on public.asks;
create policy asks_update on public.asks
  for update to authenticated using (true) with check (true);

drop policy if exists asks_delete on public.asks;
create policy asks_delete on public.asks
  for delete to authenticated using (true);

-- Old requests are not news after half an hour; this keeps the table from growing.
create or replace function public.prune_asks()
returns integer
language sql
security definer
set search_path = public
as $$
  with gone as (
    delete from public.asks where at < now() - interval '1 day' returning 1
  ) select count(*)::integer from gone;
$$;
