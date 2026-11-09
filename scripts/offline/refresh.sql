-- Local runtime evolution, independent of the immutable application migrations.
-- A brief encrypted rotation receipt handles concurrent browser tabs / lost responses.
create table if not exists offline.refresh_receipts (
  old_refresh_hash text primary key,
  session_id uuid not null references offline.sessions(id) on delete cascade,
  new_refresh_hash text not null,
  old_access_hash text,
  old_access_expires_at timestamptz,
  response_ciphertext text not null,
  expires_at timestamptz not null
);
alter table offline.refresh_receipts add column if not exists old_access_hash text;
alter table offline.refresh_receipts add column if not exists old_access_expires_at timestamptz;
create index if not exists offline_refresh_old_access on offline.refresh_receipts(old_access_hash);
create index if not exists offline_refresh_receipt_expiry on offline.refresh_receipts(expires_at);
alter table offline.refresh_receipts enable row level security;
revoke all on offline.refresh_receipts from public,anon,authenticated;
