begin;

alter table public.admins
  add column if not exists two_factor_secret_encrypted text;

-- On the next backend startup, AdminTotpMigrationService encrypts existing
-- plaintext values with TOTP_ENCRYPTION_KEY and clears this legacy column.
-- Keep the old column temporarily so deployment can be rolled out safely.

commit;
