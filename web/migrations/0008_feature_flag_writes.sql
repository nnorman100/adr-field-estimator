-- Feature flag changes (S3-11b): the platform operator's write path on company_feature_flags. This
-- file only adds; nothing in 0001 to 0007 changes. Until now the runtime could only read a
-- company's flags (0003), and the app could not recognise an operator (0006 adds that).
--
-- 1. Only an active platform operator, in its own context (withOperator, 0006), may insert or update
--    a flag row, and only for the one company that context names (app.company_id), stamped with
--    that operator's own id. A company transaction (an owner, estimator or office user) never runs
--    with an operator, so it matches nothing: an owner cannot turn a feature on for themselves
--    (owner decision D12).
-- 2. Column rights only: a row is created with its company, name, value, operator and time, and
--    afterwards only its value, operator and time change. A row's company and name never change.
--    There is still no DELETE and no TRUNCATE: a switched-off flag is a row with enabled = false.
-- 3. The reads stay as 0003 left them (the current company's rows); the operator reads a company's
--    flags through the same policy, with that company set in its context.
--
-- The list of known flag names stays in code (web/src/lib/flags/known.ts), not in a constraint, so
-- adding a flag needs no migration. The route refuses an unknown name before it writes anything.

CREATE POLICY company_feature_flags_operator_insert ON company_feature_flags
  FOR INSERT TO dryscope_runtime
  WITH CHECK (
    (SELECT app_operator_active())
    AND company_id = app_company_id()
    AND updated_by_operator_id = app_operator_id()
  );

CREATE POLICY company_feature_flags_operator_update ON company_feature_flags
  FOR UPDATE TO dryscope_runtime
  USING ((SELECT app_operator_active()) AND company_id = app_company_id())
  WITH CHECK (
    (SELECT app_operator_active())
    AND company_id = app_company_id()
    AND updated_by_operator_id = app_operator_id()
  );

GRANT INSERT (company_id, flag, enabled, updated_by_operator_id, updated_at) ON company_feature_flags TO dryscope_runtime;
GRANT UPDATE (enabled, updated_by_operator_id, updated_at) ON company_feature_flags TO dryscope_runtime;
