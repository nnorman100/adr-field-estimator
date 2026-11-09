-- Foundation for the numbered ledger. Business columns, sign-in, permissions, prices,
-- signed documents and row-level security belong in later migrations.

CREATE TABLE migration_ledger (
  id text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
