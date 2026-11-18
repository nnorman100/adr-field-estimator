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

ALTER FUNCTION sign_in_company(text) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION platform_operator(text, text) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION sign_in_company_page(text) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION signing_link_company(text) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION document_link_company(text) SET search_path = pg_catalog, pg_temp;

ALTER FUNCTION app_operator_active() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION access_projection_due_companies(integer) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION job_submission_due_companies(integer, integer) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION live_session_due_companies(integer) SET search_path = pg_catalog, pg_temp;
