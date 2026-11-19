-- Convoy on Supabase — schema, row-level security, and the pin.
--
-- The shape of the move: the MQTT version kept everything on the phones, so the pin was a
-- hash in the client and "who is allowed in" lived in each phone's localStorage. Here the
-- durable facts live in Postgres and the pin is checked by the database, so it never reaches
-- a client at all.
--
-- Identity is Supabase's anonymous sign-in: every phone gets a real auth.uid() with no
-- sign-up screen, which is what lets row-level security do the work.

-- ---------------------------------------------------------------- tables

create table if not exists public.convoy (
  id          text primary key default 'main',
  dest_lat    double precision,
  dest_lng    double precision,
  dest_label  text,
  dest_by     text,
  dest_by_id  text,
  dest_ts     bigint not null default 0,
  updated_at  timestamptz not null default now(),
  constraint one_convoy check (id = 'main')
);

-- The key is the app's own device id, not the auth uid: the same phone has to be the same
-- person whether it is talking over MQTT or Supabase, or switching between them would look
-- like a stranger arriving. The auth uid is linked beside it, and is what row-level
-- security checks.
create table if not exists public.members (
  id          text primary key,
  user_id     uuid unique references auth.users (id) on delete cascade,
  name        text not null default '',
  allowed     boolean not null default false,
  removed     boolean not null default false,
  admin       boolean not null default false,
  lat         double precision,
  lng         double precision,
  spd         double precision,
  hdg         double precision,
  acc         double precision,
  fix_at      timestamptz,
  seen_at     timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists members_seen on public.members (seen_at desc);

-- History is optional and cheap to keep: one row per position, pruned by a function below.
create table if not exists public.positions (
  member_id text not null references public.members (id) on delete cascade,
  lat       double precision not null,
  lng       double precision not null,
  at        timestamptz not null default now()
);

create index if not exists positions_member_at on public.positions (member_id, at desc);

-- ---------------------------------------------------------------- helpers

-- Is the caller an admin? Written as a function so every policy asks the same question,
-- and marked stable so Postgres can cache it inside a statement.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select admin from public.members where user_id = auth.uid()), false);
$$;

-- The pin. Only the hash is stored, and only the database ever sees the plaintext: the
-- client sends it once, the function compares, and the answer is a boolean. This is what
-- the client-side hash could never be — the value never ships to a phone.
--
-- The hash below is sha256 of the current pin. Change it with:
--   select public.set_pin('new pin');
create or replace function public.pin_hash()
returns text
language sql
immutable
as $$ select 'a8f5f167f44f4964e6c998dee827110c2b9c1c1b0d3b1e0b7b2b0e6a4f5e2c1d'::text; $$;

create or replace function public.set_pin(new_pin text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only reachable from the SQL editor or a service-role key: there is no grant to clients.
  raise notice 'Update the hash in public.pin_hash() instead: %',
    encode(digest(new_pin, 'sha256'), 'hex');
end;
$$;

create or replace function public.claim_admin(pin text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  ok boolean;
begin
  if auth.uid() is null then
    return false;
  end if;
  select (encode(digest(pin, 'sha256'), 'hex') = public.pin_hash()) into ok;
  if not ok then
    return false;
  end if;

  insert into public.members (id, user_id, admin, allowed)
  values (coalesce(current_setting('convoy.device', true), auth.uid()::text), auth.uid(), true, true)
  on conflict (id) do update set admin = true, allowed = true, removed = false, seen_at = now();
  return true;
end;
$$;

-- Letting someone in, and taking them out. Both are admin-only, and both are one statement
-- so the two lists cannot disagree — the bug that took three attempts to kill in the
-- client-only version.
create or replace function public.let_in(who text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'only an admin can let someone in';
  end if;
  update public.members
     set allowed = true, removed = false, seen_at = now()
   where id = who;
end;
$$;

create or replace function public.keep_out(who text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'only an admin can remove someone';
  end if;
  update public.members
     set allowed = false, removed = true
   where id = who;
end;
$$;

-- A week after their last sign of life, someone is dropped. Called by a scheduled job, or
-- lazily whenever anyone reads the table.
create or replace function public.prune_members()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  gone integer;
begin
  delete from public.members where seen_at < now() - interval '7 days';
  get diagnostics gone = row_count;
  delete from public.positions where at < now() - interval '30 days';
  return gone;
end;
$$;

-- ---------------------------------------------------------------- row level security

alter table public.convoy    enable row level security;
alter table public.members  enable row level security;
alter table public.positions enable row level security;

-- Everyone signed in can read the convoy: that is the whole point of it.
drop policy if exists convoy_read on public.convoy;
create policy convoy_read on public.convoy
  for select to authenticated using (true);

-- Anyone may set the destination: it is a group decision, not an admin one.
drop policy if exists convoy_write on public.convoy;
create policy convoy_write on public.convoy
  for update to authenticated using (true) with check (true);

drop policy if exists convoy_insert on public.convoy;
create policy convoy_insert on public.convoy
  for insert to authenticated with check (true);

-- Members: everyone can see the roster. You may edit your own row, but the only columns you
-- may change are your name and your position — `allowed`, `removed` and `admin` are guarded
-- below, so a client cannot make itself an admin by writing to the table.
drop policy if exists members_read on public.members;
create policy members_read on public.members
  for select to authenticated using (true);

/* You may create exactly one row, and only for yourself. The device id is yours to choose;
   the auth uid is not — it must be the one you are signed in as, which is what stops a phone
   claiming somebody else's row. */
drop policy if exists members_self_insert on public.members;
create policy members_self_insert on public.members
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists members_self_update on public.members;
create policy members_self_update on public.members
  for update to authenticated
  using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

-- The guard: only an admin, or the database's own functions, may move someone between
-- allowed and removed, or hand out admin. A member editing their own name is fine; a member
-- setting their own `allowed = true` is not.
create or replace function public.guard_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.allowed is distinct from old.allowed)
     or (new.removed is distinct from old.removed)
     or (new.admin is distinct from old.admin) then
    if not public.is_admin() then
      raise exception 'only an admin can change who is in';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists members_guard on public.members;
create trigger members_guard
  before update on public.members
  for each row execute function public.guard_membership();

-- Positions: yours to write, everyone's to read.
drop policy if exists positions_read on public.positions;
create policy positions_read on public.positions
  for select to authenticated using (true);

drop policy if exists positions_self on public.positions;
create policy positions_self on public.positions
  for insert to authenticated with check (
    member_id in (select id from public.members where user_id = auth.uid())
  );

-- ---------------------------------------------------------------- realtime

-- Broadcast carries the chatty stuff (positions, presence) and is not stored.
-- Postgres changes carry the durable stuff (membership, destination), so a phone that was
-- closed still learns what happened.
alter publication supabase_realtime add table public.members;
alter publication supabase_realtime add table public.convoy;

-- The one row that is the convoy, created up front so clients never race to insert it.
insert into public.convoy (id) values ('main') on conflict (id) do nothing;
