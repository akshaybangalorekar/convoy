-- Web Push subscriptions, and the one thing worth pushing.
--
-- This is what makes "the app is in the background" stop meaning "out of sight". The
-- service worker holds a push subscription; the row here is what an Edge Function posts
-- to. Works on Android Chrome and on an installed iOS app from 16.4 — Safari will not
-- deliver a push to a browser tab, and nothing can change that.

create table if not exists public.push_subs (
  endpoint   text primary key,
  member_id  text not null references public.members (id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  at         timestamptz not null default now()
);

create index if not exists push_subs_member on public.push_subs (member_id);

alter table public.push_subs enable row level security;

-- You may only register a subscription for yourself, and only read or remove your own.
drop policy if exists push_own on public.push_subs;
create policy push_own on public.push_subs
  for all to authenticated
  using (member_id in (select id from public.members where user_id = auth.uid()))
  with check (member_id in (select id from public.members where user_id = auth.uid()));

-- Events worth waking a phone for. Written by the app when something happens; read by the
-- Edge Function, which sends the pushes and then marks them done.
create table if not exists public.events (
  id        bigserial primary key,
  kind      text not null,              -- 'join' | 'arrived' | 'dest' | 'behind'
  body      text not null default '',
  about     text,                       -- the member it concerns, if any
  sent_at   timestamptz,
  at        timestamptz not null default now()
);

create index if not exists events_pending on public.events (at) where sent_at is null;

alter table public.events enable row level security;

drop policy if exists events_write on public.events;
create policy events_write on public.events
  for insert to authenticated with check (true);

drop policy if exists events_read on public.events;
create policy events_read on public.events
  for select to authenticated using (true);
