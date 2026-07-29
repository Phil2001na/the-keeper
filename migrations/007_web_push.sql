-- 007_web_push — browser push subscriptions, so the web surface can reach out
--
-- Until now Telegram was the only place the Keeper could actually *interrupt*
-- Philip: the web UI could show a proactive touchpoint, but only if a tab was
-- already open and looking. A Web Push subscription is what lets an installed
-- PWA be woken with the app closed.
--
-- Subscriptions are per-device and genuinely disposable — a browser may rotate
-- an endpoint at any time, and the push service answers 404/410 once one is
-- dead. src/web/push.ts prunes on that signal rather than trying to keep them
-- alive, and the page re-registers itself on every boot.

create table if not exists keeper_push_subscriptions (
  endpoint      text primary key,
  -- The browser's ECDH public key and auth secret (RFC 8291). Without both, a
  -- payload can't be encrypted for this device.
  p256dh        text not null,
  auth          text not null,
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  last_sent_at  timestamptz,
  failures      int not null default 0,
  last_error    text
);

-- A small server-side key/value store for things the process must remember
-- across restarts but which aren't part of the Keeper's memory of Philip.
-- Currently just the VAPID keypair: it identifies this server to every push
-- service, so losing it silently unsubscribes every installed device.
create table if not exists keeper_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- Every keeper_* table is RLS-on with zero policies: the service-role key
-- bypasses RLS, so the agent still reads and writes freely, while anon and
-- authenticated get nothing through PostgREST. That matters more here than
-- elsewhere — keeper_settings holds the VAPID *private* key, which is the
-- credential that proves a push came from this server.
alter table keeper_push_subscriptions enable row level security;
alter table keeper_settings enable row level security;
