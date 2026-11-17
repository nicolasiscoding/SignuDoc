-- TurboSign webhook: the secret TurboSign signs its deliveries with, once
-- this install has set up its webhook. One row at most. The secret is kept
-- encrypted with a key derived from BETTER_AUTH_SECRET, like the seal key.

create table if not exists public.turbosign_settings (
  id boolean primary key default true check (id),
  webhook_secret_encrypted text not null,
  updated_at bigint not null
);
