-- Sign-in and company separation (S3): every identity table in one additive migration.
-- Row-level security, the runtime role and append-only grants come in 0003.
--
-- Rules the constraints hold:
-- - A person is an actor bound to one sign-in tenant and uid, never to an email alone.
-- - An actor, membership, invitation or outbox row of one company can never point at a row of
--   another company: references between company rows carry company_id in a composite key.
-- - One active owner per company and one active membership per actor.
-- - Every sign-in tenant has one kind: a company's tenant or the operator-only tenant. Platform
--   operators are actors with no company, signed in through an operator tenant.

-- Every sign-in tenant the app knows. A tenant id has exactly one kind, so a company's tenant
-- and the operator tenant can never be the same tenant.
CREATE TABLE auth_tenants (
  id text PRIMARY KEY CHECK (id <> '' AND id = btrim(id)),
  kind text NOT NULL CHECK (kind IN ('company', 'operator')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_tenants_id_kind_key UNIQUE (id, kind)
);

-- Companies created by 0001 keep their id and created_at. A row that existed before this file
-- gets a placeholder name, so the column can be required for every company created after it.
ALTER TABLE companies
  ADD COLUMN name text,
  ADD COLUMN sign_in_slug text,
  ADD COLUMN status text NOT NULL DEFAULT 'active',
  ADD COLUMN auth_tenant_id text,
  ADD COLUMN auth_tenant_kind text GENERATED ALWAYS AS ('company') STORED,
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
  ADD CONSTRAINT companies_auth_tenant_id_check
    CHECK (auth_tenant_id <> '' AND auth_tenant_id = btrim(auth_tenant_id)),
  -- The company is found from the verified token's tenant, so one tenant names one company.
  ADD CONSTRAINT companies_auth_tenant_id_key UNIQUE (auth_tenant_id),
  -- Lets an actor's company and sign-in tenant be checked together.
  ADD CONSTRAINT companies_id_auth_tenant_id_key UNIQUE (id, auth_tenant_id),
  -- A company signs in only through a tenant registered as a company tenant.
  ADD CONSTRAINT companies_auth_tenant_fkey FOREIGN KEY (auth_tenant_id, auth_tenant_kind)
    REFERENCES auth_tenants (id, kind);

-- A signed-in person. company_id is empty only for an actor that belongs to no company, such as
-- a platform operator; such an actor can hold no membership because the composite keys below
-- never match an empty company_id. An actor of a company signs in through that company's tenant;
-- an actor with no company signs in through an operator tenant.
CREATE TABLE actors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid,
  auth_tenant_id text NOT NULL CHECK (auth_tenant_id <> '' AND auth_tenant_id = btrim(auth_tenant_id)),
  uid text NOT NULL CHECK (uid <> '' AND uid = btrim(uid)),
  -- Last verified email seen at sign-in, for display and invitation matching only.
  email text NOT NULL CHECK (email <> '' AND email = lower(btrim(email))),
  display_name text CHECK (display_name = btrim(display_name) AND char_length(display_name) BETWEEN 1 AND 200),
  auth_tenant_kind text GENERATED ALWAYS AS (
    CASE WHEN company_id IS NULL THEN 'operator' ELSE 'company' END
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT actors_tenant_uid_key UNIQUE (auth_tenant_id, uid),
  CONSTRAINT actors_company_id_id_key UNIQUE (company_id, id),
  CONSTRAINT actors_id_auth_tenant_kind_key UNIQUE (id, auth_tenant_kind),
  CONSTRAINT actors_company_tenant_fkey FOREIGN KEY (company_id, auth_tenant_id)
    REFERENCES companies (id, auth_tenant_id),
  CONSTRAINT actors_tenant_kind_fkey FOREIGN KEY (auth_tenant_id, auth_tenant_kind)
    REFERENCES auth_tenants (id, kind)
);

-- Platform operators: actors with no company, in an operator tenant. Not a membership: support
-- access is granted and audited separately.
CREATE TABLE platform_admins (
  actor_id uuid PRIMARY KEY,
  actor_kind text GENERATED ALWAYS AS ('operator') STORED,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_admins_actor_fkey FOREIGN KEY (actor_id, actor_kind)
    REFERENCES actors (id, auth_tenant_kind)
);

-- Stored states are pending, accepted and cancelled; an invitation past expires_at is expired.
CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies (id),
  email text NOT NULL CHECK (email <> '' AND email = lower(btrim(email))),
  role text NOT NULL CHECK (role IN ('owner', 'estimator', 'office')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'cancelled')),
  expires_at timestamptz NOT NULL,
  -- Who invited: a member of this company, or a platform operator (an owner invitation).
  created_by_actor_id uuid,
  created_by_operator_id uuid REFERENCES platform_admins (actor_id),
  accepted_by_actor_id uuid,
  accepted_at timestamptz,
  cancelled_at timestamptz,
  cleared_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invitations_company_id_id_key UNIQUE (company_id, id),
  CONSTRAINT invitations_created_by_fkey FOREIGN KEY (company_id, created_by_actor_id)
    REFERENCES actors (company_id, id),
  CONSTRAINT invitations_one_creator_check
    CHECK (created_by_actor_id IS NULL OR created_by_operator_id IS NULL),
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

-- Written in the same transaction as the change it records. details holds ids and counts only,
-- never emails, tokens or passwords. company_id is empty for platform-wide events. actor_id is a
-- member of company_id; operator_actor_id is a platform operator (support actions included); both
-- are empty for system events.
CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id uuid REFERENCES companies (id),
  actor_id uuid,
  operator_actor_id uuid REFERENCES platform_admins (actor_id),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]{0,63}$'),
  target text CHECK (char_length(target) <= 200),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_events_actor_fkey FOREIGN KEY (company_id, actor_id)
    REFERENCES actors (company_id, id),
  CONSTRAINT audit_events_member_has_company_check CHECK (actor_id IS NULL OR company_id IS NOT NULL),
  CONSTRAINT audit_events_one_actor_check CHECK (actor_id IS NULL OR operator_actor_id IS NULL)
);

CREATE INDEX audit_events_company_created ON audit_events (company_id, created_at);

-- Per-company switches. The list of known names lives in code; a missing row means off. Only a
-- platform operator changes them (owner decision D12).
CREATE TABLE company_feature_flags (
  company_id uuid NOT NULL REFERENCES companies (id),
  flag text NOT NULL CHECK (flag ~ '^[a-z][a-z0-9_]{0,63}$'),
  enabled boolean NOT NULL DEFAULT false,
  updated_by_operator_id uuid REFERENCES platform_admins (actor_id),
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
