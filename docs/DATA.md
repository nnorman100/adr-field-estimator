# Data

What personal and customer data DryScope holds, where it lives, who can see it, and how long it is
kept. Written from the code at the time of writing; where only a document (not code) states a fact,
it is marked **doc-only**. Who may do what is in [ACCESS.md](ACCESS.md); logging and secrets rules
are in [SECURITY.md](SECURITY.md).

The sections of this document, one file per area (each keeps its original headings):

- [Current app: summary, where personal data lives, who sees what](data/current-app.md): Summary; Where personal data lives (Firestore, Cloud Storage, Firebase Authentication, the phone, email and other processors, logs, vault backup); Who sees what, at a glance.
- [Retention](data/retention.md): Retention (the old app).
- [Rebuilt app: backups, logs and AI data under Technology Standard 2.7](data/standard-2-7.md): Rebuilt app: backups, logs and AI data under Technology Standard 2.7 (planned).
- [Rebuilt app Postgres: backups, ledger and identity tables](data/postgres-ledger-and-identity.md): Rebuilt app Postgres (not deployed): Cloud SQL backups, the migration ledger, `0001` and `0002_identity`.
- [Rebuilt app Postgres: runtime role, row-level security, lookups and the platform operator](data/postgres-rls-and-operator.md): `0003_runtime_role` to `0008_feature_flag_writes`, and `0017_definer_search_path` (the caller's temporary schema searched last in every `SECURITY DEFINER` function).
- [Rebuilt app Postgres: price tables](data/postgres-prices.md): `0009_price_tables`.
- [Rebuilt app Postgres: core job tables](data/postgres-jobs.md): `0010_core_job_tables`, `0015_office_jobs` (assignments, office notes, corrections after signing), and `0016_job_drafts` (each field draft id claimed once for one job).
- [Rebuilt app Postgres: submissions, estimates and agreements](data/postgres-submissions.md): `0011_submissions_agreements`.
- [Rebuilt app Postgres: AI and Live tables](data/postgres-ai-live.md): `0012_ai_live_tables`.
- [Rebuilt app Postgres: company documents, signing links and document links](data/postgres-documents-and-links.md): `0013_company_documents` and `0014_signing_links`.
- [Rebuilt app Postgres: how migrations are changed](data/postgres-migration-rules.md): The additive rule (add, switch, remove) and the migrator.
- [Rebuilt app S5a: personal data at a glance](data/s5a-personal-data.md): Where the rebuilt app's jobs, photos, signing and links hold personal data, who reads it, and how the isolation gate proves each place (S5a-12).
- [Rebuilt app field database: Firestore rules](data/field-rules.md): Rebuilt app field database (not deployed): what the rules allow and check.
- [Rebuilt app field database: how the access records follow Postgres](data/field-access-records.md): The access projection (S3-12); the S6 job locator projection.
