-- Sign-in lookup (S3-7): find the company of a verified sign-in tenant before any company is set.
--
-- Every runtime query runs inside withCompany, which needs a company id. A request only knows the
-- tenant in its verified sign-in token, so the server first asks sign_in_company(tenant) for the
-- company id, then reads the actor, membership and company status inside withCompany under the
-- 0003 policies. This file only adds; nothing in 0001 to 0003 changes.
--
-- The function runs as the table owner (SECURITY DEFINER). Row-level security is forced, so the
-- owner reads companies only through the SELECT policy below, and only while this function runs:
-- the function sets app.sign_in_lookup around its one read, and the policy needs both that
-- setting and the owner. The runtime is never a member of the owner role, so setting the value
-- itself shows it nothing. Outside the function the owner still reads no company row, as in 0003, and
-- it can never add, change or remove one: the policy is for SELECT only.
--
-- The function returns one company id or NULL, never a row. NULL means "not a company sign-in":
-- an unknown tenant, an empty one, or an operator tenant (operators have no company). A company
-- that is suspended or archived still resolves; withCompany re-reads its status and refuses it.

CREATE POLICY companies_owner_read ON companies
  FOR SELECT TO PUBLIC
  USING (
    current_setting('app.sign_in_lookup', true) = 'on'
    AND pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.companies'::regclass), 'USAGE')
  );

-- The setting is turned on for the one read and cleared after it. A non-superuser cannot attach a
-- custom setting to a function (PostgreSQL 15 and later), so the body sets it. If the read fails,
-- the transaction or savepoint rolls back and the setting with it.
CREATE FUNCTION sign_in_company(tenant text) RETURNS uuid
  LANGUAGE plpgsql STRICT
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  found uuid;
BEGIN
  -- No company has an empty tenant (companies_auth_tenant_id_check), so '' finds nothing.
  PERFORM set_config('app.sign_in_lookup', 'on', true);
  SELECT c.id INTO found FROM public.companies c WHERE c.auth_tenant_id = tenant;
  PERFORM set_config('app.sign_in_lookup', '', true);
  RETURN found;
END
$$;

-- Functions are executable by everyone by default. Only the runtime may call this one.
REVOKE ALL ON FUNCTION sign_in_company(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sign_in_company(text) TO dryscope_runtime;
