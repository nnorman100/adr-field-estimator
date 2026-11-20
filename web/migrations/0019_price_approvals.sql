-- Proposals and approvals on a job (S5b-8, docs/plans/S5/S5b-8.md; pricing plan S5b-3; spec.md 6.1),
-- and the submission and agreement kind `revision` for S5b-9. This file only adds: one table, its
-- guard and policies, and a wider kind on job_submissions and agreements. No table, column, row or
-- policy of 0001 to 0018 is removed, and no kind is renamed. No route reads or writes the new table
-- yet (the server slice of S5b-8 does).
--
-- 1. job_price_approvals: what the estimator proposes on a submitted job and the owner approves
--    (owner decisions 2026-11-20, D1 to D4):
--    - a named adjustment from the pinned price table (S5b-7), by its id;
--    - a custom multiplier on one priced line: an item in one room, or a job-wide item (no room),
--      above 1 and at most 3 with two decimal places, surcharges only;
--    - an hourly, unit or flat addition: a description, the hours, quantity and unit, or neither,
--      and its price (the hourly rate is the price table's additional work rate when proposed), and
--      whether a unit or flat addition is taxable (an hourly one is taxed as the additional work
--      item is), and for an hourly addition the name of the approver as entered at approval (the
--      proposal prints it, as the additional work flow does today). Additions never change the
--      company's price table.
--    Each row is bound to the job's committed submission of its current draft, the job revision and
--    the pinned price version's content hash when it is proposed, and it can be proposed, approved
--    or ended only while the job is submitted at that revision and pin and no estimate has been made
--    from that submission on any pin (D1: a change after the estimate, a reprice onto a newer pin
--    included, goes through Back to editing and Finish, so job_estimates is unchanged). A finished
--    job has a pin only once its first estimate is made, so the first proposal on a job with no pin
--    will establish the first price pin (sequence 1, reason first_price, the company's newest
--    published version, the pin rules of the estimate service) under the job lock; that route is the
--    server slice of S5b-8, and a job that already has its first pin and no estimate is priced from
--    that pin, which makes no second one. What a row says never changes: an edit ends the row
--    (`edited`) and proposes a new one, which has no approval; a newly approved named adjustment
--    ends the approved one it replaces (`replaced`). A row is approved once and ended once, and the
--    database takes both times from its clock. Who may propose and approve is the route's check
--    (`additions_approve`, today the owner).
--    A reprice moves the job's pin onto a newer version (S5b-6), and the estimate service then refuses
--    to price any record of the draft that was current at the move (confirmationPredatesReprice: the
--    job's current pin has reason owner_reprice and a `job_repriced` audit row names its sequence and
--    that draft). So once a pin is added with reason owner_reprice, every open row of the job ends
--    (`repriced`, by the owner who repriced) in the same transaction, and no proposal, approval or end
--    is accepted on a submission of such a draft: the job goes through Back to editing and Finish, which
--    makes a new draft and submission. Only that end skips the binding checks (the pin has just moved,
--    and the job's status, revision and estimate are no longer the row's concern), and it is refused
--    unless the row's pin is no longer the job's newest and the newest was added by a reprice.
-- 2. Kind `revision` (S5b-9; revisions after signing, owner decision 2026-11-13): a revised estimate
--    supersedes a signed agreement and names it as its parent, as a change order does. The kind
--    checks on job_submissions and agreements are replaced by wider ones under the same names
--    (`original`, `change_order` and now `revision`); every stored row passes them unchanged. One
--    original agreement per job still holds; revisions and change orders are not counted there.
-- 3. Every row belongs to a company and is held only inside withCompany (0003). A platform operator
--    reads a company's rows through withOperator with that company set; every write policy refuses
--    an active operator. Every key carries company_id. No DELETE and no TRUNCATE for the runtime.

-- The kind checks scan job_submissions and agreements while holding them exclusively. A lock this
-- file waits for more than 5 seconds fails it, and the whole file rolls back with nothing applied
-- (the release is then run again), as 0018 does. For this file's transaction only.
SET LOCAL lock_timeout = '5s';

-- 2. Kind `revision`. Each table's old check is dropped and the wider one added under the same name
-- in this one transaction, so no row is ever unchecked.
ALTER TABLE job_submissions
  DROP CONSTRAINT job_submissions_kind_check,
  ADD CONSTRAINT job_submissions_kind_check CHECK (kind IN ('original', 'change_order', 'revision')),
  DROP CONSTRAINT job_submissions_parent_check,
  -- A change order or a revision names the agreement it builds on, and an original does not.
  ADD CONSTRAINT job_submissions_parent_check CHECK ((kind IN ('change_order', 'revision')) = (parent_agreement_id IS NOT NULL));

ALTER TABLE agreements
  DROP CONSTRAINT agreements_kind_check,
  ADD CONSTRAINT agreements_kind_check CHECK (kind IN ('original', 'change_order', 'revision')),
  DROP CONSTRAINT agreements_parent_check,
  ADD CONSTRAINT agreements_parent_check CHECK ((kind IN ('change_order', 'revision')) = (parent_agreement_id IS NOT NULL));

-- 1. Proposals and approvals.
CREATE TABLE job_price_approvals (
  -- Made on the phone (a uuid), so a retried proposal finds its row.
  id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES companies (id),
  job_id uuid NOT NULL,
  -- What the row is bound to (trigger below): the job's committed submission of its current draft,
  -- the job's current pin and that pin's version's content hash, and the job revision.
  submission_id uuid NOT NULL,
  pin_id uuid NOT NULL,
  table_hash text NOT NULL CHECK (table_hash ~ '^[0-9a-f]{64}$'),
  job_revision integer NOT NULL CHECK (job_revision >= 1),
  kind text NOT NULL CHECK (kind IN ('named_adjustment', 'line_multiplier', 'hourly', 'unit', 'flat')),
  -- A named adjustment: its id in the pinned table (that it is there is the route's check).
  adjustment_id text CHECK (adjustment_id ~ '^[a-z][a-z0-9_]{1,39}$'),
  -- A custom multiplier: the item's id, and the room's field id, or no room for a job-wide item.
  item_id text CHECK (item_id ~ '^[a-z][a-z0-9_]{1,39}$'),
  room_id text CHECK (char_length(room_id) BETWEEN 1 AND 64 AND room_id ~ '^[A-Za-z0-9_-]+$'),
  -- Decimals are stored exactly as sent: a value with more than two decimal places is refused, not rounded.
  multiplier numeric CHECK (multiplier > 1 AND multiplier <= 3 AND scale(multiplier) <= 2),
  -- An addition: one line of text as entered (kept exactly, padding included, and holding a character
  -- that is not whitespace, Unicode spaces included, by a class that does not depend on the database
  -- locale), the hours (hourly) or quantity and unit (unit), and its price: the hourly rate, the unit
  -- price or the flat amount.
  description text
    CHECK (char_length(description) BETWEEN 1 AND 300 AND description ~ '[^ \t\n\v\f\r\u0085\u00a0\u1680\u180e\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]' AND description !~ '[[:cntrl:]]'),
  quantity numeric CHECK (quantity > 0 AND quantity <= 100000 AND scale(quantity) <= 2),
  unit text CHECK (char_length(unit) BETWEEN 1 AND 20 AND unit ~ '[^ \t\n\v\f\r\u0085\u00a0\u1680\u180e\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]' AND unit !~ '[[:cntrl:]]'),
  price numeric CHECK (price > 0 AND price <= 100000 AND scale(price) <= 2),
  taxable boolean,
  -- SHA-256 of the propose request: the same id and body is the same proposal.
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  proposed_by_actor_id uuid NOT NULL,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  approved_by_actor_id uuid,
  approved_at timestamptz,
  -- An hourly addition: the approver's name as entered at approval, kept exactly as entered.
  approved_by_name text
    CHECK (char_length(approved_by_name) BETWEEN 1 AND 150 AND approved_by_name ~ '[^ \t\n\v\f\r\u0085\u00a0\u1680\u180e\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]' AND approved_by_name !~ '[[:cntrl:]]'),
  ended_by_actor_id uuid,
  ended_at timestamptz,
  ended_reason text CHECK (ended_reason IN ('edited', 'replaced', 'repriced')),
  PRIMARY KEY (company_id, id),
  CONSTRAINT job_price_approvals_job_fkey FOREIGN KEY (company_id, job_id) REFERENCES jobs (company_id, id),
  CONSTRAINT job_price_approvals_submission_fkey FOREIGN KEY (company_id, job_id, submission_id)
    REFERENCES job_submissions (company_id, job_id, id),
  CONSTRAINT job_price_approvals_pin_fkey FOREIGN KEY (company_id, job_id, pin_id)
    REFERENCES job_price_pins (company_id, job_id, id),
  CONSTRAINT job_price_approvals_proposed_by_fkey FOREIGN KEY (company_id, proposed_by_actor_id)
    REFERENCES actors (company_id, id),
  CONSTRAINT job_price_approvals_approved_by_fkey FOREIGN KEY (company_id, approved_by_actor_id)
    REFERENCES actors (company_id, id),
  CONSTRAINT job_price_approvals_ended_by_fkey FOREIGN KEY (company_id, ended_by_actor_id)
    REFERENCES actors (company_id, id),
  -- Each kind holds exactly its own fields.
  CONSTRAINT job_price_approvals_shape_check CHECK (
    CASE kind
      WHEN 'named_adjustment' THEN adjustment_id IS NOT NULL AND item_id IS NULL AND room_id IS NULL AND multiplier IS NULL
        AND description IS NULL AND quantity IS NULL AND unit IS NULL AND price IS NULL AND taxable IS NULL
      WHEN 'line_multiplier' THEN adjustment_id IS NULL AND item_id IS NOT NULL AND multiplier IS NOT NULL
        AND description IS NULL AND quantity IS NULL AND unit IS NULL AND price IS NULL AND taxable IS NULL
      WHEN 'hourly' THEN adjustment_id IS NULL AND item_id IS NULL AND room_id IS NULL AND multiplier IS NULL
        AND description IS NOT NULL AND quantity IS NOT NULL AND quantity BETWEEN 0.25 AND 200 AND unit IS NULL
        AND price IS NOT NULL AND price <= 10000 AND taxable IS NULL
      WHEN 'unit' THEN adjustment_id IS NULL AND item_id IS NULL AND room_id IS NULL AND multiplier IS NULL
        AND description IS NOT NULL AND quantity IS NOT NULL AND unit IS NOT NULL AND price IS NOT NULL AND taxable IS NOT NULL
      WHEN 'flat' THEN adjustment_id IS NULL AND item_id IS NULL AND room_id IS NULL AND multiplier IS NULL
        AND description IS NOT NULL AND quantity IS NULL AND unit IS NULL AND price IS NOT NULL AND taxable IS NOT NULL
      ELSE false
    END
  ),
  -- Approved exactly when it says when and by whom; ended likewise, and with a reason.
  CONSTRAINT job_price_approvals_approved_check CHECK ((approved_at IS NULL) = (approved_by_actor_id IS NULL)),
  -- The approver's name is there exactly when an hourly row is approved.
  CONSTRAINT job_price_approvals_approver_name_check CHECK ((kind = 'hourly' AND approved_at IS NOT NULL) = (approved_by_name IS NOT NULL)),
  CONSTRAINT job_price_approvals_ended_check CHECK (
    (ended_at IS NULL) = (ended_by_actor_id IS NULL) AND (ended_at IS NULL) = (ended_reason IS NULL)
  ),
  -- Only an approved named adjustment is replaced.
  CONSTRAINT job_price_approvals_replaced_check CHECK (
    ended_reason IS DISTINCT FROM 'replaced' OR (kind = 'named_adjustment' AND approved_at IS NOT NULL)
  )
);

-- One open custom multiplier per line of a submission at a job revision: a second proposal for the
-- same item in the same room (or the same job-wide item) is refused until the first is ended. A row
-- left open when the job revision moved (a customer save, a reprice) is no longer bound to the job,
-- so it can no longer change, and a proposal at the new revision is not blocked by it.
CREATE UNIQUE INDEX job_price_approvals_one_multiplier_per_line
  ON job_price_approvals (company_id, submission_id, job_revision, item_id, coalesce(room_id, ''))
  WHERE kind = 'line_multiplier' AND ended_at IS NULL;

-- At most one approved named adjustment in force per submission and job revision (D4): approving
-- another first ends this one as replaced, in the same transaction.
CREATE UNIQUE INDEX job_price_approvals_one_named_adjustment
  ON job_price_approvals (company_id, submission_id, job_revision)
  WHERE kind = 'named_adjustment' AND approved_at IS NOT NULL AND ended_at IS NULL;

-- A submission's open rows, as the estimate reads them (those at the job's revision and pin are in force).
CREATE INDEX job_price_approvals_submission ON job_price_approvals (company_id, submission_id, job_revision) WHERE ended_at IS NULL;

-- What a row may do. It is made proposed (no approval, not ended), bound to the job as it is now. It
-- then may be approved once and ended once, each in its own change, each only while the binding
-- still holds and before an estimate is made; the database takes each time from its clock. Nothing
-- else of a row ever changes, and an ended row changes no more. Runs as the caller, under the
-- caller's row-level security. A column added later is frozen until this list names it
-- (tests/db/price-approvals-table.test.ts checks the list).
CREATE FUNCTION job_price_approvals_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  job_status text;
  job_revision integer;
  job_draft uuid;
  submission_status text;
  submission_draft uuid;
  pin_sequence integer;
  version_hash text;
  current_pin_id uuid;
  current_pin_sequence integer;
  current_pin_reason text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.approved_by_actor_id IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.approved_by_name IS NOT NULL
       OR NEW.ended_by_actor_id IS NOT NULL OR NEW.ended_at IS NOT NULL OR NEW.ended_reason IS NOT NULL THEN
      RAISE EXCEPTION 'a price approval starts as a proposal' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (NEW.id, NEW.company_id, NEW.job_id, NEW.submission_id, NEW.pin_id, NEW.table_hash, NEW.job_revision, NEW.kind,
        NEW.adjustment_id, NEW.item_id, NEW.room_id, NEW.multiplier, NEW.description, NEW.quantity, NEW.unit, NEW.price,
        NEW.taxable, NEW.request_digest, NEW.proposed_by_actor_id, NEW.proposed_at)
       IS DISTINCT FROM
       (OLD.id, OLD.company_id, OLD.job_id, OLD.submission_id, OLD.pin_id, OLD.table_hash, OLD.job_revision, OLD.kind,
        OLD.adjustment_id, OLD.item_id, OLD.room_id, OLD.multiplier, OLD.description, OLD.quantity, OLD.unit, OLD.price,
        OLD.taxable, OLD.request_digest, OLD.proposed_by_actor_id, OLD.proposed_at) THEN
      RAISE EXCEPTION 'what a price approval says cannot change' USING ERRCODE = '23514';
    END IF;
    IF OLD.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'an ended price approval cannot change' USING ERRCODE = '23514';
    END IF;
    IF NEW.approved_by_name IS DISTINCT FROM OLD.approved_by_name
       AND NEW.approved_by_actor_id IS NOT DISTINCT FROM OLD.approved_by_actor_id THEN
      RAISE EXCEPTION 'the approver''s name is set with the approval and never changes' USING ERRCODE = '23514';
    END IF;
    IF NEW.approved_by_actor_id IS DISTINCT FROM OLD.approved_by_actor_id THEN
      IF OLD.approved_by_actor_id IS NOT NULL OR NEW.approved_by_actor_id IS NULL THEN
        RAISE EXCEPTION 'a price approval is approved once' USING ERRCODE = '23514';
      END IF;
      IF NEW.ended_by_actor_id IS NOT NULL OR NEW.ended_reason IS NOT NULL THEN
        RAISE EXCEPTION 'a price approval is approved and ended in separate changes' USING ERRCODE = '23514';
      END IF;
      NEW.approved_at := now();
    ELSIF NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
      RAISE EXCEPTION 'a price approval takes its approval time from the database' USING ERRCODE = '23514';
    ELSIF NEW.ended_by_actor_id IS NOT NULL OR NEW.ended_reason IS NOT NULL THEN
      IF NEW.ended_by_actor_id IS NULL OR NEW.ended_reason IS NULL THEN
        RAISE EXCEPTION 'a price approval ends by someone, for a reason' USING ERRCODE = '23514';
      END IF;
      NEW.ended_at := now();
    ELSIF OLD.approved_by_actor_id IS NOT NULL THEN
      RAISE EXCEPTION 'a price approval is approved once' USING ERRCODE = '23514';
    ELSE
      RAISE EXCEPTION 'a price approval changes only by its approval or its end' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Ending as repriced runs inside the reprice's own transaction (the pins trigger below), which
  -- already holds the job row, so the newest pin it reads is the one just added.
  IF TG_OP = 'UPDATE' AND NEW.ended_reason = 'repriced' THEN
    SELECT p.id, p.reason INTO current_pin_id, current_pin_reason
    FROM public.job_price_pins p WHERE p.company_id = NEW.company_id AND p.job_id = NEW.job_id
    ORDER BY p.sequence DESC LIMIT 1;
    IF current_pin_reason IS DISTINCT FROM 'owner_reprice' OR NEW.pin_id = current_pin_id THEN
      RAISE EXCEPTION 'a price approval ends as repriced only when its job was repriced onto a newer pin' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- The binding, checked at every change. A row the keys will refuse anyway (a missing job,
  -- submission or pin) is left to them.
  SELECT j.status, j.revision, j.current_draft_id INTO job_status, job_revision, job_draft
  FROM public.jobs j WHERE j.company_id = NEW.company_id AND j.id = NEW.job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF job_status <> 'submitted' THEN
    RAISE EXCEPTION 'a price approval is made on a submitted job' USING ERRCODE = '23514';
  END IF;
  IF job_revision <> NEW.job_revision THEN
    RAISE EXCEPTION 'the job has changed since the proposal' USING ERRCODE = '23514';
  END IF;

  -- The job's newest pin, read under the job row lock taken above, so a reprice that commits while
  -- this change waits is seen.
  SELECT p.sequence, p.reason INTO current_pin_sequence, current_pin_reason
  FROM public.job_price_pins p WHERE p.company_id = NEW.company_id AND p.job_id = NEW.job_id
  ORDER BY p.sequence DESC LIMIT 1;

  SELECT s.status, s.draft_id INTO submission_status, submission_draft
  FROM public.job_submissions s WHERE s.company_id = NEW.company_id AND s.job_id = NEW.job_id AND s.id = NEW.submission_id;
  IF FOUND AND (submission_status <> 'committed' OR submission_draft IS DISTINCT FROM job_draft) THEN
    RAISE EXCEPTION 'a price approval is bound to the committed record of the job''s current draft' USING ERRCODE = '23514';
  END IF;

  SELECT p.sequence, v.content_hash INTO pin_sequence, version_hash
  FROM public.job_price_pins p
  JOIN public.price_table_versions v ON v.company_id = p.company_id AND v.id = p.version_id
  WHERE p.company_id = NEW.company_id AND p.job_id = NEW.job_id AND p.id = NEW.pin_id;
  IF FOUND THEN
    IF NEW.table_hash <> version_hash THEN
      RAISE EXCEPTION 'a price approval states the content hash of its pinned version' USING ERRCODE = '23514';
    END IF;
    IF pin_sequence <> current_pin_sequence THEN
      RAISE EXCEPTION 'the job''s price pin has moved since the proposal' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- The same rule as the estimate service's confirmationPredatesReprice: the draft of this submission
  -- was the job's current one when the owner moved the pin to its current version.
  IF current_pin_reason = 'owner_reprice' AND EXISTS (
    SELECT 1 FROM public.audit_events e
    WHERE e.company_id = NEW.company_id AND e.target = NEW.job_id::text AND e.action = 'job_repriced'
      AND e.details->>'sequence' = current_pin_sequence::text AND e.details->>'job_draft' = submission_draft::text
  ) THEN
    RAISE EXCEPTION 'the job was repriced: go back to editing and Finish to price it again' USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM public.job_estimates e
  WHERE e.company_id = NEW.company_id AND e.submission_id = NEW.submission_id;
  IF FOUND THEN
    RAISE EXCEPTION 'the estimate is already made: go back to editing to change its prices' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION job_price_approvals_guard() FROM PUBLIC;

CREATE TRIGGER job_price_approvals_guard
  BEFORE INSERT OR UPDATE ON job_price_approvals
  FOR EACH ROW EXECUTE FUNCTION job_price_approvals_guard();

-- A reprice ends the job's open rows: the pin the owner adds ends them as repriced, as the caller
-- (so under row-level security), by the same owner. The guard lets only this end through unchecked.
CREATE FUNCTION job_price_pins_end_approvals() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE public.job_price_approvals a
  SET ended_by_actor_id = NEW.pinned_by_actor_id, ended_reason = 'repriced'
  WHERE a.company_id = NEW.company_id AND a.job_id = NEW.job_id AND a.ended_at IS NULL;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION job_price_pins_end_approvals() FROM PUBLIC;

CREATE TRIGGER job_price_pins_end_approvals
  AFTER INSERT ON job_price_pins
  FOR EACH ROW WHEN (NEW.reason = 'owner_reprice')
  EXECUTE FUNCTION job_price_pins_end_approvals();

-- An estimate made while an approval of its submission is being written waits for the job
-- row lock both take, so the estimate prices either before the change (and the change is then
-- refused above) or after it.

-- Row-level security on and forced, so the table owner (the migrator) is bound too.
ALTER TABLE job_price_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_price_approvals FORCE ROW LEVEL SECURITY;

-- The current company's rows. Reading takes only the company; writing also refuses an active
-- platform operator. No policy allows DELETE.
CREATE POLICY job_price_approvals_select ON job_price_approvals
  FOR SELECT TO dryscope_runtime
  USING (company_id = app_company_id());

CREATE POLICY job_price_approvals_insert ON job_price_approvals
  FOR INSERT TO dryscope_runtime
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

CREATE POLICY job_price_approvals_update ON job_price_approvals
  FOR UPDATE TO dryscope_runtime
  USING (company_id = app_company_id() AND NOT (SELECT app_operator_active()))
  WITH CHECK (company_id = app_company_id() AND NOT (SELECT app_operator_active()));

-- Table rights. No DELETE and no TRUNCATE. Only who approved (and the name they entered) and who
-- ended it, and why, may be set (the trigger sets both times); never what the row says.
GRANT SELECT, INSERT ON job_price_approvals TO dryscope_runtime;
GRANT UPDATE (approved_by_actor_id, approved_by_name, ended_by_actor_id, ended_reason) ON job_price_approvals TO dryscope_runtime;
