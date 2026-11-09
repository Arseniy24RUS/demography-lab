-- Local-only evolution from device/recovery identification to the explicit email/name flow.
-- Historical identities and contributions remain intact; a map selects one participant per email.
alter table offline.accounts drop constraint if exists accounts_check;
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='offline.accounts'::regclass
      and conname='offline_accounts_host_has_no_recovery') then
    alter table offline.accounts add constraint offline_accounts_host_has_no_recovery
      check(kind='participant' or recovery_hash is null);
  end if;
end $$;
create table if not exists offline.email_identities (
  normalized_email text primary key check(char_length(normalized_email) between 3 and 254),
  user_id uuid unique not null references offline.accounts(user_id),
  created_at timestamptz not null default now(),
  last_identified_at timestamptz not null default now()
);
alter table offline.email_identities enable row level security;
revoke all on offline.email_identities from public,anon,authenticated;
