-- TRADECOM orders board — Supabase setup. Run once in Supabase → SQL Editor → New query → Run.
-- Who may sign in is the `allowed` list at the bottom; add or remove emails there any time.

-- 1) people allowed to use the board (Google account emails)
create table if not exists public.allowed (email text primary key);
alter table public.allowed enable row level security;

create or replace function public.is_allowed() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.allowed where lower(email) = lower(auth.jwt() ->> 'email'))
$$;
grant execute on function public.is_allowed() to authenticated;

-- the sign-in page asks this before emailing a link, so strangers cannot use up the email quota
create or replace function public.can_sign_in(e text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.allowed where lower(email) = lower(trim(e)))
$$;
grant execute on function public.can_sign_in(text) to anon, authenticated;

-- 2) board data: one row per document (collection "orders" / "buyers" / "events"), body in jsonb
create table if not exists public.docs (
  coll text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (coll, id)
);
alter table public.docs enable row level security;
drop policy if exists docs_rw on public.docs;
create policy docs_rw on public.docs for all to authenticated
  using (public.is_allowed()) with check (public.is_allowed());

-- merge top-level fields into a document (creates it when missing), in one atomic step
create or replace function public.doc_merge(c text, i text, patch jsonb) returns void
language sql security invoker set search_path = public as $$
  insert into public.docs (coll, id, data, updated_at) values (c, i, patch, now())
  on conflict (coll, id) do update set data = public.docs.data || excluded.data, updated_at = now()
$$;
grant execute on function public.doc_merge(text, text, jsonb) to authenticated;

-- live updates for everyone who has the board open
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- 3) private file storage (contracts, invoices, declarations…)
insert into storage.buckets (id, name, public, file_size_limit)
values ('files', 'files', false, 52428800)
on conflict (id) do nothing;

drop policy if exists files_rw on storage.objects;
create policy files_rw on storage.objects for all to authenticated
  using (bucket_id = 'files' and public.is_allowed())
  with check (bucket_id = 'files' and public.is_allowed());

-- 4) the people who may sign in — edit this list
insert into public.allowed (email) values
  ('first.person@gmail.com'),
  ('second.person@gmail.com')
on conflict do nothing;
