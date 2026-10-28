-- PrintFlow 0010: enquiries, and the tenancy that lets a print shop trade before
-- its university has signed anything.
--
-- ## Why enquiries sit outside the tenancy model
--
-- Everything else in this database is scoped to a university, because everything
-- else happens after a university exists. An enquiry is the opposite: it is how
-- we find out a university should exist at all. So `enquiries` has no mandatory
-- university_id, and the row is written by an anonymous visitor rather than by a
-- member of a tenant. `university_id` is filled in later, if and when we work out
-- who they belong to — or when we create the tenant for them.
--
-- ## Unclaimed tenancy
--
-- A print shop next to a campus wants to trade, but their university has never
-- heard of us. Three ways to answer that:
--
--   1. Refuse until the university signs. Loses the shop, and the shop is the one
--      who actually wanted this.
--   2. Make university_id nullable across the schema. Every composite foreign key
--      (id, university_id), every tenancy guard and every row-level check in this
--      database exists to make cross-tenant leakage impossible; unpicking that for
--      a sales case would be the single most dangerous change we could make.
--   3. Create the university anyway, and record that nobody from it has claimed it.
--
-- Three is what this does, because it is also true: the students are real students
-- at a real university. The university simply has not signed up yet. The tenant is
-- created UNCLAIMED, PrintFlow administers it in place of university staff, and the
-- shop trades. If the university signs later, the same tenant is claimed — the id
-- never changes, so every order, document, payment and audit row written in the
-- meantime is already theirs, with no migration and no reconciliation.

ALTER TABLE universities
  -- UNIVERSITY: someone from the university runs this tenant and has admin accounts.
  -- UNCLAIMED:  PrintFlow created it so a shop could trade; there are no university
  --             admins, so platform staff approve shops and set policy here.
  ADD COLUMN tenancy text NOT NULL DEFAULT 'UNIVERSITY' CHECK (tenancy IN ('UNIVERSITY', 'UNCLAIMED')),
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN claimed_by uuid REFERENCES users (id);

-- A claimed tenant must record when it was claimed, and an unclaimed one must not
-- pretend it was. The flag and the timestamp cannot drift apart.
ALTER TABLE universities
  ADD CONSTRAINT universities_claim_consistent
  CHECK ((tenancy = 'UNCLAIMED' AND claimed_at IS NULL) OR (tenancy = 'UNIVERSITY'));

COMMENT ON COLUMN universities.tenancy IS
  'UNCLAIMED means PrintFlow created this tenant so a shop could trade before the university signed up. Platform staff stand in for university admins until it is claimed.';

CREATE TABLE enquiries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference       text NOT NULL UNIQUE CHECK (reference ~ '^ENQ-[0-9A-Z]{8}$'),
  kind            text NOT NULL CHECK (kind IN ('UNIVERSITY', 'PRINT_SHOP', 'STUDENT', 'OTHER')),
  status          text NOT NULL DEFAULT 'NEW'
                  CHECK (status IN ('NEW', 'OPEN', 'WAITING_ON_THEM', 'ESCALATED', 'CONVERTED', 'CLOSED', 'SPAM')),
  priority        text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),

  -- What they told us. Nothing here is trusted: it is displayed as text, never
  -- interpolated into mail headers, and the address is only ever replied to.
  name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  email           text NOT NULL CHECK (length(email) BETWEEN 5 AND 254),
  phone           text CHECK (phone IS NULL OR length(phone) BETWEEN 6 AND 30),
  organisation    text CHECK (organisation IS NULL OR length(btrim(organisation)) BETWEEN 2 AND 200),
  role            text CHECK (role IS NULL OR length(btrim(role)) BETWEEN 2 AND 120),
  message         text NOT NULL CHECK (length(btrim(message)) BETWEEN 10 AND 4000),

  -- Filled in when we know, which is usually later than when they wrote.
  university_id   uuid REFERENCES universities (id),
  assigned_to     uuid REFERENCES users (id),

  source          text NOT NULL DEFAULT 'WEB' CHECK (source IN ('WEB', 'EMAIL', 'IMPORT')),
  -- Kept for abuse investigation only, and dropped with the enquiry.
  remote_ip       inet,
  user_agent      text CHECK (user_agent IS NULL OR length(user_agent) <= 400),

  -- How long someone waited for a human. Set once, by the first reply that leaves.
  first_response_at timestamptz,
  closed_at       timestamptz,
  -- What this enquiry turned into, if it turned into anything.
  converted_university_id uuid REFERENCES universities (id),
  converted_shop_id       uuid REFERENCES shops (id),

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX enquiries_queue_idx ON enquiries (status, priority, created_at DESC);
CREATE INDEX enquiries_assigned_idx ON enquiries (assigned_to, status) WHERE assigned_to IS NOT NULL;
CREATE INDEX enquiries_email_idx ON enquiries (lower(email), created_at DESC);

/**
 * The thread: everything that has happened to an enquiry, in order. Append-only,
 * like the audit log and for the same reason — "who said what to this person, and
 * when" is exactly the record you need when a conversation goes wrong, and a row
 * that can be edited afterwards is not a record of anything.
 */
CREATE TABLE enquiry_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  enquiry_id    uuid NOT NULL REFERENCES enquiries (id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('RECEIVED', 'REPLY', 'NOTE', 'STATUS', 'ASSIGNED', 'ESCALATED', 'CONVERTED')),
  -- NULL for the visitor's own first message; set for anything staff did.
  actor_user_id uuid REFERENCES users (id),
  body          text CHECK (body IS NULL OR length(body) <= 8000),
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Whether this event was sent to the enquirer, so nobody has to guess whether a
  -- note was private. Notes are never delivered; replies always are.
  emailed       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX enquiry_events_thread_idx ON enquiry_events (enquiry_id, id);

CREATE TRIGGER enquiry_events_no_update BEFORE UPDATE ON enquiry_events
  FOR EACH ROW EXECUTE FUNCTION pf_reject_mutation();
CREATE TRIGGER enquiry_events_no_delete BEFORE DELETE ON enquiry_events
  FOR EACH ROW EXECUTE FUNCTION pf_reject_mutation();

/**
 * Keeps the enquiry's own summary honest: touches updated_at on every change, and
 * stamps closed_at exactly when it reaches a terminal status rather than relying
 * on each caller to remember.
 */
CREATE FUNCTION pf_enquiry_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.status IN ('CLOSED', 'CONVERTED', 'SPAM') AND OLD.status NOT IN ('CLOSED', 'CONVERTED', 'SPAM') THEN
    NEW.closed_at := now();
  ELSIF NEW.status NOT IN ('CLOSED', 'CONVERTED', 'SPAM') THEN
    NEW.closed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enquiries_touch BEFORE UPDATE ON enquiries
  FOR EACH ROW EXECUTE FUNCTION pf_enquiry_touch();

/**
 * The first reply that leaves is the moment someone stopped waiting. Recorded by
 * the database rather than the application so it cannot be set twice, moved, or
 * forgotten by a new code path.
 */
CREATE FUNCTION pf_enquiry_first_response() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'REPLY' AND NEW.emailed THEN
    UPDATE enquiries SET first_response_at = coalesce(first_response_at, NEW.created_at)
     WHERE id = NEW.enquiry_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER enquiry_events_first_response AFTER INSERT ON enquiry_events
  FOR EACH ROW EXECUTE FUNCTION pf_enquiry_first_response();
