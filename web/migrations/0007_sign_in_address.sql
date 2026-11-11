-- Sign-in address lookup (S3-13b): the company sign-in page `/sign-in/{address}` needs the name and
-- the Identity Platform tenant of the company that owns an address, before anyone has signed in and
-- before any company is known. Both are public (the tenant id goes to every visitor's browser).
-- This file only adds; nothing in 0001 to 0006 changes, and no table or policy changes either.
--
-- sign_in_company_page(address) is built like 0004's sign_in_company: a SECURITY DEFINER function
-- owned by the migrator, executable only by the runtime, with a fixed search_path. It reads
-- `companies` through 0004's SELECT-only policy (companies_owner_read), which matches only while
-- this function (or sign_in_company) has set app.sign_in_lookup, for the table owner, in a session
-- signed in as another role. Outside the function nobody gains a row.
--
-- It returns no row for anything that is not an active company with a sign-in tenant: an unknown
-- or empty address, a company with no tenant yet, and a suspended or archived company all look the
-- same, so the page cannot be used to tell which of them exists. It returns only the two public
-- fields, never the company id, status or any other column.

CREATE FUNCTION sign_in_company_page(address text) RETURNS TABLE (company_name text, tenant_id text)
  LANGUAGE plpgsql STRICT
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  found_name text;
  found_tenant text;
BEGIN
  -- companies_sign_in_slug_check allows no empty or upper-case address, so those find nothing.
  PERFORM set_config('app.sign_in_lookup', 'on', true);
  SELECT c.name, c.auth_tenant_id INTO found_name, found_tenant
  FROM public.companies c
  WHERE c.sign_in_slug = address AND c.status = 'active' AND c.auth_tenant_id IS NOT NULL;
  PERFORM set_config('app.sign_in_lookup', '', true);
  IF found_tenant IS NOT NULL THEN
    company_name := found_name;
    tenant_id := found_tenant;
    RETURN NEXT;
  END IF;
  RETURN;
END
$$;

-- Functions are executable by everyone by default. Only the runtime may call this one.
REVOKE ALL ON FUNCTION sign_in_company_page(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sign_in_company_page(text) TO dryscope_runtime;
