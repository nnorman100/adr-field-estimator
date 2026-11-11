-- Platform operator (S3-9): recognise an operator at sign-in, and let the runtime act across
-- companies only inside a verified operator context. This file only adds; nothing in 0001 to 0005
-- changes.
--
-- 1. platform_operator(tenant, uid) finds the operator signing in, the way 0004's sign_in_company
--    finds a company: a SECURITY DEFINER function owned by the migrator, executable only by the
--    runtime, that returns an actor id or NULL and nothing else.
-- 2. withOperator (web/src/db/tenant.ts) sets app.operator_id for one transaction, as withCompany
--    sets app.company_id. app_operator_active() is true only while that setting names an active
--    platform_admins row, so the new runtime policies below match nothing for anyone else: an
--    owner, estimator or office user never runs with it, and a disabled operator's id gets nothing.
-- 3. With an active operator the runtime may list companies, create one (name and sign-in address
--    only), change its status, set its sign-in tenant once, and register a company tenant. It can
--    never add an operator: there is still no grant on platform_admins beyond the empty read, an
--    actor with no company matches no runtime policy, and an operator tenant cannot be inserted.
-- 4. A trigger on companies holds the two rules a policy cannot see (a policy sees only the new
--    row) for the runtime: archive needs a suspended company, and a company's sign-in tenant never
--    changes once set. The table owner keeps its repair path (a mis-bound tenant before anyone
--    signed in through it), as every other owner-only change.
-- 5. An audit row may name an operator only inside that operator's own context.
-- 6. add_platform_operator(tenant, uid, email) is the owner-run command that adds an operator. Only
--    the table owner may run it, signed in as itself (npm run platform:add-operator).

-- The operator of the current transaction, or NULL when none is set ('' after a transaction ends).
-- A value that is not a uuid raises an error instead of matching anything.
CREATE FUNCTION app_operator_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
  RETURN NULLIF(current_setting('app.operator_id', true), '')::uuid;

REVOKE ALL ON FUNCTION app_operator_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_operator_id() TO dryscope_runtime;

-- The owner reads one platform_admins row: the one the current context names, and only from a
-- function the runtime called (session_user differs) while running with the owner's rights.
CREATE POLICY platform_admins_owner_context ON platform_admins
  FOR SELECT TO PUBLIC
  USING (
    actor_id = app_operator_id()
    AND session_user IS DISTINCT FROM current_user
    AND pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.platform_admins'::regclass), 'USAGE')
  );

-- True only while app.operator_id names an active platform operator.
CREATE FUNCTION app_operator_active() RETURNS boolean
  LANGUAGE sql STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_admins p
    WHERE p.actor_id = public.app_operator_id() AND p.status = 'active'
  )
$$;

REVOKE ALL ON FUNCTION app_operator_active() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_operator_active() TO dryscope_runtime;

-- The sign-in lookup reads company-less actors and platform_admins only while the function below
-- runs, gated like 0004 (the setting, a session signed in as someone else, the owner's rights).
CREATE POLICY actors_owner_operator_lookup ON actors
  FOR SELECT TO PUBLIC
  USING (
    company_id IS NULL
    AND current_setting('app.operator_lookup', true) = 'on'
    AND session_user IS DISTINCT FROM current_user
    AND pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.actors'::regclass), 'USAGE')
  );

CREATE POLICY platform_admins_owner_lookup ON platform_admins
  FOR SELECT TO PUBLIC
  USING (
    current_setting('app.operator_lookup', true) = 'on'
    AND session_user IS DISTINCT FROM current_user
    AND pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.platform_admins'::regclass), 'USAGE')
  );

-- The active platform operator signed in through this tenant with this uid, or NULL. An actor with
-- no company signs in only through an operator tenant (0002's foreign keys), so a company tenant
-- never matches. A disabled operator returns NULL.
CREATE FUNCTION platform_operator(tenant text, account_uid text) RETURNS uuid
  LANGUAGE plpgsql STRICT
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  found uuid;
BEGIN
  PERFORM set_config('app.operator_lookup', 'on', true);
  SELECT a.id INTO found
  FROM public.actors a
  JOIN public.platform_admins p ON p.actor_id = a.id
  WHERE a.company_id IS NULL AND a.auth_tenant_id = tenant AND a.uid = account_uid AND p.status = 'active';
  PERFORM set_config('app.operator_lookup', '', true);
  RETURN found;
END
$$;

REVOKE ALL ON FUNCTION platform_operator(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_operator(text, text) TO dryscope_runtime;

-- The runtime's cross-company rights, each for an active operator only. The subselect runs the
-- check once per statement.
CREATE POLICY companies_operator_read ON companies
  FOR SELECT TO dryscope_runtime
  USING ((SELECT app_operator_active()));

CREATE POLICY companies_operator_insert ON companies
  FOR INSERT TO dryscope_runtime
  WITH CHECK ((SELECT app_operator_active()));

CREATE POLICY companies_operator_update ON companies
  FOR UPDATE TO dryscope_runtime
  USING ((SELECT app_operator_active()))
  WITH CHECK ((SELECT app_operator_active()));

CREATE POLICY auth_tenants_operator_read ON auth_tenants
  FOR SELECT TO dryscope_runtime
  USING ((SELECT app_operator_active()));

-- Only a company's tenant. Operator tenants come only from add_platform_operator.
CREATE POLICY auth_tenants_operator_insert ON auth_tenants
  FOR INSERT TO dryscope_runtime
  WITH CHECK ((SELECT app_operator_active()) AND kind = 'company');

-- An operator's own audit rows, for any company (the company row is checked by the foreign key).
CREATE POLICY audit_events_operator_insert ON audit_events
  FOR INSERT TO dryscope_runtime
  WITH CHECK ((SELECT app_operator_active()) AND actor_id IS NULL AND operator_actor_id = app_operator_id());

-- Restrictive, so it holds beside 0003's company policy: a runtime audit row names an operator only
-- inside that operator's active context, never by a company transaction alone.
CREATE POLICY audit_events_operator_named ON audit_events
  AS RESTRICTIVE
  FOR INSERT TO dryscope_runtime
  WITH CHECK (
    operator_actor_id IS NULL
    OR (operator_actor_id = app_operator_id() AND (SELECT app_operator_active()))
  );

-- Column rights only: a company is created with a name and a sign-in address (status defaults to
-- active), and afterwards only its status and sign-in tenant change.
GRANT INSERT (name, sign_in_slug) ON companies TO dryscope_runtime;
GRANT UPDATE (status, auth_tenant_id, updated_at) ON companies TO dryscope_runtime;
GRANT INSERT (id, kind) ON auth_tenants TO dryscope_runtime;

-- The rules a policy cannot see, for every role but the table owner (and a superuser, which has the
-- owner's rights): the runtime, whatever context it runs in.
CREATE FUNCTION companies_guard_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.companies'::regclass), 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF OLD.auth_tenant_id IS NOT NULL AND NEW.auth_tenant_id IS DISTINCT FROM OLD.auth_tenant_id THEN
    RAISE EXCEPTION 'a company''s sign-in tenant cannot change once it is set' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'archived' AND OLD.status NOT IN ('suspended', 'archived') THEN
    RAISE EXCEPTION 'a company must be suspended before it is archived' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION companies_guard_change() FROM PUBLIC;

CREATE TRIGGER companies_guard_change
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION companies_guard_change();

-- The owner-run command's rights: the table owner, signed in as itself (not through a function the
-- runtime called), while add_platform_operator has set app.platform_command. Nothing else matches.
CREATE POLICY auth_tenants_owner_command ON auth_tenants
  FOR ALL TO PUBLIC
  USING (
    current_setting('app.platform_command', true) = 'add_operator'
    AND session_user = current_user
    AND pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.auth_tenants'::regclass), 'USAGE')
  )
  WITH CHECK (
    kind = 'operator'
    AND current_setting('app.platform_command', true) = 'add_operator'
    AND session_user = current_user
    AND pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.auth_tenants'::regclass), 'USAGE')
  );

CREATE POLICY actors_owner_command ON actors
  FOR ALL TO PUBLIC
  USING (
    company_id IS NULL
    AND current_setting('app.platform_command', true) = 'add_operator'
    AND session_user = current_user
    AND pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.actors'::regclass), 'USAGE')
  )
  WITH CHECK (
    company_id IS NULL
    AND current_setting('app.platform_command', true) = 'add_operator'
    AND session_user = current_user
    AND pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.actors'::regclass), 'USAGE')
  );

CREATE POLICY platform_admins_owner_command ON platform_admins
  FOR ALL TO PUBLIC
  USING (
    current_setting('app.platform_command', true) = 'add_operator'
    AND session_user = current_user
    AND pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.platform_admins'::regclass), 'USAGE')
  )
  WITH CHECK (
    current_setting('app.platform_command', true) = 'add_operator'
    AND session_user = current_user
    AND pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.platform_admins'::regclass), 'USAGE')
  );

-- Only the command's own audit row: platform-wide, no member and no operator acting.
CREATE POLICY audit_events_owner_command ON audit_events
  FOR INSERT TO PUBLIC
  WITH CHECK (
    action = 'operator_added'
    AND company_id IS NULL AND actor_id IS NULL AND operator_actor_id IS NULL
    AND current_setting('app.platform_command', true) = 'add_operator'
    AND session_user = current_user
    AND pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.audit_events'::regclass), 'USAGE')
  );

-- Adds one platform operator (owner decision D6): the person's account must already exist in the
-- operator tenant (made in the Console). Registers the tenant as an operator tenant the first time,
-- creates the company-less actor and its platform_admins row, and writes one audit row. Running it
-- again for an active operator changes nothing and returns the same id; a disabled operator is
-- refused, because re-enabling one is not this command. Returns the operator's actor id.
CREATE FUNCTION add_platform_operator(tenant text, account_uid text, account_email text) RETURNS uuid
  LANGUAGE plpgsql STRICT
  SET search_path = pg_catalog
AS $$
DECLARE
  tenant_kind text;
  operator uuid;
  operator_status text;
BEGIN
  PERFORM set_config('app.platform_command', 'add_operator', true);

  SELECT t.kind INTO tenant_kind FROM public.auth_tenants t WHERE t.id = tenant;
  IF tenant_kind IS NULL THEN
    INSERT INTO public.auth_tenants (id, kind) VALUES (tenant, 'operator');
  ELSIF tenant_kind <> 'operator' THEN
    RAISE EXCEPTION 'tenant % is a company tenant, not an operator tenant', tenant USING ERRCODE = '22023';
  END IF;

  SELECT a.id INTO operator FROM public.actors a WHERE a.auth_tenant_id = tenant AND a.uid = account_uid;
  IF operator IS NULL THEN
    INSERT INTO public.actors (company_id, auth_tenant_id, uid, email)
    VALUES (NULL, tenant, account_uid, lower(btrim(account_email)))
    RETURNING id INTO operator;
  END IF;

  SELECT p.status INTO operator_status FROM public.platform_admins p WHERE p.actor_id = operator;
  IF operator_status = 'disabled' THEN
    RAISE EXCEPTION 'this operator is disabled; this command does not re-enable one' USING ERRCODE = '22023';
  ELSIF operator_status IS NULL THEN
    INSERT INTO public.platform_admins (actor_id) VALUES (operator);
    INSERT INTO public.audit_events (action, target) VALUES ('operator_added', operator::text);
  END IF;

  PERFORM set_config('app.platform_command', '', true);
  RETURN operator;
END
$$;

REVOKE ALL ON FUNCTION add_platform_operator(text, text, text) FROM PUBLIC;
