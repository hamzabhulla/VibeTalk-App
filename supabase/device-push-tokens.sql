-- device_push_tokens: FCM registration tokens for the Android app.
-- The web's push_subscriptions table is Web-Push-only (endpoint
-- allowlist + p256dh/auth) and cannot carry FCM tokens, so mobile
-- push gets its own table. Run once in the Supabase SQL editor.
-- Delivery additionally needs an FCM sender (server-side, with the
-- Firebase service-account key kept as a server secret).

create table if not exists public.device_push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  token text not null,
  platform text not null default 'android' check (platform in ('android', 'ios')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, token)
);

create index if not exists device_push_tokens_user_idx
  on public.device_push_tokens (user_id);

alter table public.device_push_tokens enable row level security;

drop policy if exists "device_tokens_select_own" on public.device_push_tokens;
create policy "device_tokens_select_own" on public.device_push_tokens
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "device_tokens_insert_own" on public.device_push_tokens;
create policy "device_tokens_insert_own" on public.device_push_tokens
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "device_tokens_update_own" on public.device_push_tokens;
create policy "device_tokens_update_own" on public.device_push_tokens
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "device_tokens_delete_own" on public.device_push_tokens;
create policy "device_tokens_delete_own" on public.device_push_tokens
  for delete to authenticated
  using (auth.uid() = user_id);

-- Realtime is NOT needed for this table.
