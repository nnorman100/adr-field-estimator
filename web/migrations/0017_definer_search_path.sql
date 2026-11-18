-- The caller's temporary schema is searched last in every SECURITY DEFINER function (security audit
-- F4). No table, row, policy or grant changes; only each function's search_path setting does.
--
-- Each of these functions runs as its owner, the migrator, which owns every table, and was created
-- with SET search_path = pg_catalog. Without pg_temp written in the path, PostgreSQL searches the
-- calling session's temporary schema first for relation and type names. The API user may create
-- temporary objects, so it could create a temporary domain called uuid or text whose CHECK calls
-- its own function; a lookup that declares a variable of that type (found uuid, found_name text)
-- would then run that function as the table owner. Writing pg_temp last, as the PostgreSQL manual
-- says for SECURITY DEFINER functions ("Writing SECURITY DEFINER Functions Safely" under CREATE
-- FUNCTION), makes pg_catalog's types win. The temporary schema is never searched for function or
-- operator names.
--
-- The five lookups the runtime calls with a declared variable were shown to run the caller's code:
-- sign_in_company (0004), platform_operator (0006), sign_in_company_page (0007),
-- signing_link_company and document_link_company (0014). The other four definer functions name no
-- type or table through the path; they get the same setting so every definer function is alike.
-- ALTER FUNCTION keeps each function's owner, body and grants. A definer function added later
-- writes SET search_path = pg_catalog, pg_temp and names its types with their schema
-- (pg_catalog.uuid, pg_catalog.text).
--
-- The setting alone is not enough for those five. The API user may also call plpgsql_validator, which
-- compiles a function body under the caller's own search_path, without the function's SET, and keeps
-- the compiled copy for the session under a key that includes the input collation. A later call whose
-- argument collation is indeterminate (for example a || b with a COLLATE "C" and b COLLATE "POSIX")
-- reuses that copy, whose local variable is bound to the caller's temporary domain, and the domain's
-- check then runs as the owner. So the five bodies are recreated below with every name resolved by
-- schema: local variable types as pg_catalog.uuid and pg_catalog.text, function calls as
-- pg_catalog.set_config, operators as OPERATOR(pg_catalog.=), tables already as public.*. Each body is
-- otherwise the one from its original migration. CREATE OR REPLACE keeps the owner and the grants.

ALTER FUNCTION sign_in_company(text) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION platform_operator(text, text) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION sign_in_company_page(text) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION signing_link_company(text) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION document_link_company(text) SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION app_operator_active() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION access_projection_due_companies(integer) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION job_submission_due_companies(integer, integer) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION live_session_due_companies(integer) SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION sign_in_company(tenant pg_catalog.text) RETURNS pg_catalog.uuid
  LANGUAGE plpgsql STRICT
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  found pg_catalog.uuid;
BEGIN
  -- No company has an empty tenant (companies_auth_tenant_id_check), so '' finds nothing.
  PERFORM pg_catalog.set_config('app.sign_in_lookup', 'on', true);
  SELECT c.id INTO found FROM public.companies c WHERE c.auth_tenant_id OPERATOR(pg_catalog.=) tenant;
  PERFORM pg_catalog.set_config('app.sign_in_lookup', '', true);
  RETURN found;
END
$$;

CREATE OR REPLACE FUNCTION platform_operator(tenant pg_catalog.text, account_uid pg_catalog.text) RETURNS pg_catalog.uuid
  LANGUAGE plpgsql STRICT
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  found pg_catalog.uuid;
BEGIN
  PERFORM pg_catalog.set_config('app.operator_lookup', 'on', true);
  SELECT a.id INTO found
  FROM public.actors a
  JOIN public.platform_admins p ON p.actor_id OPERATOR(pg_catalog.=) a.id
  WHERE a.company_id IS NULL AND a.auth_tenant_id OPERATOR(pg_catalog.=) tenant AND a.uid OPERATOR(pg_catalog.=) account_uid AND p.status OPERATOR(pg_catalog.=) 'active';
  PERFORM pg_catalog.set_config('app.operator_lookup', '', true);
  RETURN found;
END
$$;

CREATE OR REPLACE FUNCTION sign_in_company_page(address pg_catalog.text) RETURNS TABLE (company_name pg_catalog.text, tenant_id pg_catalog.text)
  LANGUAGE plpgsql STRICT
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  found_name pg_catalog.text;
  found_tenant pg_catalog.text;
BEGIN
  -- companies_sign_in_slug_check allows no empty or upper-case address, so those find nothing.
  PERFORM pg_catalog.set_config('app.sign_in_lookup', 'on', true);
  SELECT c.name, c.auth_tenant_id INTO found_name, found_tenant
  FROM public.companies c
  WHERE c.sign_in_slug OPERATOR(pg_catalog.=) address AND c.status OPERATOR(pg_catalog.=) 'active' AND c.auth_tenant_id IS NOT NULL;
  PERFORM pg_catalog.set_config('app.sign_in_lookup', '', true);
  IF found_tenant IS NOT NULL THEN
    company_name := found_name;
    tenant_id := found_tenant;
    RETURN NEXT;
  END IF;
  RETURN;
END
$$;

CREATE OR REPLACE FUNCTION signing_link_company(token_sha256 pg_catalog.text) RETURNS pg_catalog.uuid
  LANGUAGE plpgsql STRICT
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  found pg_catalog.uuid;
BEGIN
  PERFORM pg_catalog.set_config('app.link_lookup', 'on', true);
  SELECT l.company_id INTO found FROM public.signing_links l WHERE l.token_sha256 OPERATOR(pg_catalog.=) signing_link_company.token_sha256;
  PERFORM pg_catalog.set_config('app.link_lookup', '', true);
  RETURN found;
END
$$;

CREATE OR REPLACE FUNCTION document_link_company(token_sha256 pg_catalog.text) RETURNS pg_catalog.uuid
  LANGUAGE plpgsql STRICT
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  found pg_catalog.uuid;
BEGIN
  PERFORM pg_catalog.set_config('app.link_lookup', 'on', true);
  SELECT l.company_id INTO found FROM public.document_links l WHERE l.token_sha256 OPERATOR(pg_catalog.=) document_link_company.token_sha256;
  PERFORM pg_catalog.set_config('app.link_lookup', '', true);
  RETURN found;
END
$$;
