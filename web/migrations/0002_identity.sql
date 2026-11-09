-- Sign-in and company separation (S3): every identity table in one additive migration.
-- Row-level security, the runtime role and append-only grants come in 0003.
--
-- Rules the constraints hold:
-- - A person is an actor bound to one sign-in tenant and uid, never to an email alone.
-- - An actor, membership, invitation or outbox row of one company can never point at a row of
--   another company: references between company rows carry company_id in a composite key.
-- - One active owner per company and one active membership per actor.

-- Companies created by 0001 keep their id and created_at. A row that existed before this file
-- gets a placeholder name, so the column can be required for every company created after it.
ALTER TABLE companies
  ADD COLUMN name text,
  ADD COLUMN sign_in_slug text,
  ADD COLUMN status text NOT NULL DEFAULT 'active',
  ADD COLUMN auth_tenant_id text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

UPDATE companies SET name = 'Unnamed company' WHERE name IS NULL;

ALTER TABLE companies
  ALTER COLUMN name SET NOT NULL,
  ADD CONSTRAINT companies_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  ADD CONSTRAINT companies_status_check CHECK (status IN ('active', 'suspended', 'archived')),
  -- The company's sign-in address: lowercase letters, digits and inner hyphens.
  ADD CONSTRAINT companies_sign_in_slug_check
    CHECK (sign_in_slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
  ADD CONSTRAINT companies_sign_in_slug_key UNIQUE (sign_in_slug),
  ADD CONSTRAINT companies_auth_tenant_id_check CHECK (auth_tenant_id <> ''),
  -- The company is found from the verified token's tenant, so one tenant names one company.
  ADD CONSTRAINT companies_auth_tenant_id_key UNIQUE (auth_tenant_id);

-- A signed-in person. company_id is empty only for an actor that belongs to no company, such as
-- a platform operator; such an actor can hold no membership because the composite keys below
-- never match an empty company_id.
CREATE TABLE actors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES companies (id),
  auth_tenant_id text NOT NULL CHECK (auth_tenant_id <> ''),
  uid text NOT NULL CHECK (uid <> ''),
  -- Last verified email seen at sign-in, for display and invitation matching only.
  email text NOT NULL CHECK (email <> '' AND email = lower(email)),
  display_name text CHECK (char_length(display_name) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT actors_tenant_uid_key UNIQUE (auth_tenant_id, uid),
  CONSTRAINT actors_company_id_id_key UNIQUE (company_id, id)
);

-- Stored states are pending, accepted and cancelled; an invitation past expires_at is expired.
CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies (id),
  email text NOT NULL CHECK (email <> '' AND email = lower(email)),
  role text NOT NULL CHECK (role IN ('owner', 'estimator', 'office')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'cancelled')),
  expires_at timestamptz NOT NULL,
  -- The inviter may be a platform operator, who has no company, so this is not company-scoped.
  created_by_actor_id uuid REFERENCES actors (id),
  accepted_by_actor_id uuid,
  accepted_at timestamptz,
  cancelled_at timestamptz,
  cleared_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invitations_company_id_id_key UNIQUE (company_id, id),
  CONSTRAINT invitations_accepted_by_fkey FOREIGN KEY (company_id, accepted_by_actor_id)
    REFERENCES actors (company_id, id),
  CONSTRAINT invitations_accepted_check CHECK (
    (status = 'accepted') = (accepted_by_actor_id IS NOT NULL AND accepted_at IS NOT NULL)
  ),
  CONSTRAINT invitations_cancelled_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

-- One pending invitation per email in a company; resending reuses it.
CREATE UNIQUE INDEX invitations_one_pending_per_email
  ON invitations (company_id, email) WHERE status = 'pending';

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies (id),
  actor_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'estimator', 'office')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  -- The invitation this membership was accepted from; accepting it twice cannot make two.
  invitation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memberships_company_id_id_key UNIQUE (company_id, id),
  CONSTRAINT memberships_invitation_id_key UNIQUE (invitation_id),
  CONSTRAINT memberships_actor_fkey FOREIGN KEY (company_id, actor_id)
    REFERENCES actors (company_id, id),
  CONSTRAINT memberships_invitation_fkey FOREIGN KEY (company_id, invitation_id)
    REFERENCES invitations (company_id, id)
);

CREATE UNIQUE INDEX memberships_one_active_owner
  ON memberships (company_id) WHERE role = 'owner' AND status = 'active';
CREATE UNIQUE INDEX memberships_one_active_per_actor
  ON memberships (actor_id) WHERE status = 'active';

-- Platform operators. Not a membership: support access is granted and audited separately.
CREATE TABLE platform_admins (
  actor_id uuid PRIMARY KEY REFERENCES actors (id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Written in the same transaction as the change it records. details holds ids and counts only,
-- never emails, tokens or passwords. company_id and actor_id are empty for platform-wide and
-- system events.
CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id uuid REFERENCES companies (id),
  actor_id uuid REFERENCES actors (id),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]{0,63}$'),
  target text CHECK (char_length(target) <= 200),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_company_created ON audit_events (company_id, created_at);

-- Per-company switches. The list of known names lives in code; a missing row means off.
CREATE TABLE company_feature_flags (
  company_id uuid NOT NULL REFERENCES companies (id),
  flag text NOT NULL CHECK (flag ~ '^[a-z][a-z0-9_]{0,63}$'),
  enabled boolean NOT NULL DEFAULT false,
  updated_by_actor_id uuid REFERENCES actors (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, flag)
);

-- Actors whose Firestore access record must be brought in line with their committed
-- membership. A row is written in the same transaction as the membership change, so nothing
-- is projected before the change commits.
CREATE TABLE access_projection_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies (id),
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  processed_at timestamptz,
  last_error_code text CHECK (last_error_code ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT access_projection_outbox_actor_fkey FOREIGN KEY (company_id, actor_id)
    REFERENCES actors (company_id, id)
);

CREATE INDEX access_projection_outbox_pending
  ON access_projection_outbox (available_at, id) WHERE processed_at IS NULL;
