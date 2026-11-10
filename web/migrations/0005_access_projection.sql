-- Access projection (S3-12): find which companies have Firestore access records waiting to be
-- written or removed, before any company is set.
--
-- A membership change writes an access_projection_outbox row in its own transaction (0002). The
-- outbox worker (web/src/lib/projection/) runs as the runtime role and does all of its work
-- inside withCompany, under the 0003 policies: it reads the actor, membership and company, writes
-- or removes the Firestore record, and marks the row done. The one thing it cannot do there is
-- find the companies that have work waiting, because withCompany needs a company id first. This
-- file adds that one lookup, the same way 0004 adds the sign-in lookup. It only adds; nothing in
-- 0001 to 0004 changes.
--
-- access_projection_due_companies(max) returns company ids only, never outbox rows, actors or
-- anything else of a company. It runs as the table owner (SECURITY DEFINER). Row-level security is
-- forced, so the owner reads outbox rows only through the SELECT policy below, and only while the
-- function runs: the function sets app.projection_scan around its one read, and the policy needs
-- that setting, the owner's rights and a session that signed in as someone else (the runtime
-- calling the function). The runtime is never a member of the owner role, so setting the value
-- itself shows it nothing; the owner signed in as itself fails the last test. Outside the function
-- the owner still reads no outbox row, and it can never add, change or remove one through this
-- policy: it is for SELECT only.

CREATE POLICY access_projection_outbox_owner_scan ON access_projection_outbox
  FOR SELECT TO PUBLIC
  USING (
    current_setting('app.projection_scan', true) = 'on'
    AND session_user IS DISTINCT FROM current_user
    AND pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.access_projection_outbox'::regclass), 'USAGE')
  );

-- Companies with at least one row not yet done and due now, oldest waiting row first, at most
-- max_companies of them (1 to 100). The setting is turned on for the one read and cleared after
-- it; if the read fails, the transaction or savepoint rolls back and the setting with it.
CREATE FUNCTION access_projection_due_companies(max_companies integer) RETURNS SETOF uuid
  LANGUAGE plpgsql STRICT
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
BEGIN
  IF max_companies < 1 OR max_companies > 100 THEN
    RAISE EXCEPTION 'max_companies must be between 1 and 100' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.projection_scan', 'on', true);
  RETURN QUERY
    SELECT o.company_id
    FROM public.access_projection_outbox o
    WHERE o.processed_at IS NULL AND o.available_at <= now()
    GROUP BY o.company_id
    ORDER BY min(o.available_at), o.company_id
    LIMIT max_companies;
  PERFORM set_config('app.projection_scan', '', true);
  RETURN;
END
$$;

-- Functions are executable by everyone by default. Only the runtime may call this one.
REVOKE ALL ON FUNCTION access_projection_due_companies(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION access_projection_due_companies(integer) TO dryscope_runtime;

-- The worker reads one actor's waiting rows, and renewal reads when that actor's record was last
-- written.
CREATE INDEX access_projection_outbox_actor
  ON access_projection_outbox (company_id, actor_id, processed_at);
