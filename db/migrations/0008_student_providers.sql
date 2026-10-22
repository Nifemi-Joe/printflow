-- PrintFlow 0008: student-run print shops, identity verification and the risk limits
-- that follow from it.
--
-- A student with a printer in their hostel can register as a provider. Because the
-- person behind the shop is a peer rather than an inspected business, the product shows
-- students exactly how far that provider's identity has been proven, and limits what an
-- unproven provider can take on.
--
-- Levels (ordered; a shop's level is derived from its passed checks, never set by hand):
--   UNVERIFIED          nothing proven
--   EMAIL_VERIFIED      a code sent to an address on the university's student-mail domain
--   MATRIC_VERIFIED     matric number matched the university's roll, or an admin confirmed it
--   UNIVERSITY_APPROVED a university admin vetted the person or business in a recorded review
--
-- Everything that grants a level is one row in `provider_verifications`: who decided,
-- when, on what evidence, and when it must be renewed.

-- ---------------------------------------------------------------- level ordering
CREATE FUNCTION pf_provider_level_rank(level text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE level
    WHEN 'UNVERIFIED' THEN 0
    WHEN 'EMAIL_VERIFIED' THEN 1
    WHEN 'MATRIC_VERIFIED' THEN 2
    WHEN 'UNIVERSITY_APPROVED' THEN 3
  END $$;

-- ---------------------------------------------------------------- university policy
ALTER TABLE universities
  -- Student-run providers are off until a university opts in.
  ADD COLUMN student_providers_allowed boolean NOT NULL DEFAULT false,
  -- Addresses on these domains can be used to prove a provider is a student here.
  ADD COLUMN student_email_domains text[] NOT NULL DEFAULT '{}',
  -- POSIX regular expression a matric number must match, e.g. '^[0-9]{2}/[0-9]{7}$'.
  ADD COLUMN matric_pattern text CHECK (matric_pattern IS NULL OR length(matric_pattern) BETWEEN 3 AND 200),
  -- Largest order a student-run provider may take before their matric number is verified.
  ADD COLUMN student_provider_cap_kobo bigint NOT NULL DEFAULT 200000 CHECK (student_provider_cap_kobo BETWEEN 10000 AND 100000000),
  -- How long a passed check stands before it must be renewed (an academic session).
  ADD COLUMN provider_reverify_days integer NOT NULL DEFAULT 365 CHECK (provider_reverify_days BETWEEN 30 AND 1095);

-- Domains are stored lowercase and must look like domains, so matching an address
-- against them is a plain comparison with no normalising at read time.
CREATE FUNCTION pf_valid_domain_list(domains text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(domains) <= 20
     AND NOT EXISTS (SELECT 1 FROM unnest(domains) AS d WHERE d <> lower(d) OR d !~ '^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$')
$$;
ALTER TABLE universities ADD CONSTRAINT universities_student_domains_valid CHECK (pf_valid_domain_list(student_email_domains));

-- ---------------------------------------------------------------- shops
ALTER TABLE shops
  ADD COLUMN kind text NOT NULL DEFAULT 'BUSINESS' CHECK (kind IN ('BUSINESS', 'STUDENT_RUN')),
  ADD COLUMN verification_level text NOT NULL DEFAULT 'UNVERIFIED'
             CHECK (verification_level IN ('UNVERIFIED', 'EMAIL_VERIFIED', 'MATRIC_VERIFIED', 'UNIVERSITY_APPROVED')),
  -- Set when the owner accepts the confidentiality undertaking (student-run shops only).
  ADD COLUMN undertaking_version integer,
  ADD COLUMN undertaking_accepted_at timestamptz;

CREATE INDEX shops_kind_idx ON shops (university_id, kind, verification_level);

-- ---------------------------------------------------------------- the evidence trail
-- One row per identity check. Append-only in spirit: what was checked never changes, and
-- a decided check can only be expired or revoked, never quietly re-decided.
CREATE TABLE provider_verifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id       uuid NOT NULL,
  university_id uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('STUDENT_EMAIL', 'MATRIC_NUMBER', 'UNIVERSITY_REVIEW')),
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PASSED', 'FAILED', 'EXPIRED', 'REVOKED')),
  -- The subject of the check, kept to the minimum that makes it meaningful to a reviewer:
  -- the student email, the matric number, or the name of the person reviewed.
  subject       text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  -- How it was decided: { "method": "ROLL_MATCH" | "ADMIN", "rollMatched": true, ... }.
  evidence      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  -- Null for automatic checks (a code entered, a roll matched); set for human decisions.
  decided_by    uuid REFERENCES users (id),
  note          text CHECK (length(note) <= 1000),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  expires_at    timestamptz,
  FOREIGN KEY (shop_id, university_id) REFERENCES shops (id, university_id),
  CHECK (status = 'PENDING' OR decided_at IS NOT NULL),
  CHECK (expires_at IS NULL OR decided_at IS NULL OR expires_at > decided_at)
);
CREATE INDEX provider_verifications_shop_idx ON provider_verifications (shop_id, kind, status);
-- At most one check of each kind may stand at a time.
CREATE UNIQUE INDEX provider_verifications_one_live ON provider_verifications (shop_id, kind) WHERE status IN ('PENDING', 'PASSED');
-- The expiry sweep looks here.
CREATE INDEX provider_verifications_expiry ON provider_verifications (expires_at) WHERE status = 'PASSED';

CREATE FUNCTION pf_provider_verification_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('PENDING', 'PASSED', 'FAILED') THEN
      RAISE EXCEPTION 'pf: a check starts PENDING, PASSED or FAILED' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.shop_id, NEW.university_id, NEW.kind, NEW.subject, NEW.requested_at)
     IS DISTINCT FROM ROW(OLD.shop_id, OLD.university_id, OLD.kind, OLD.subject, OLD.requested_at) THEN
    RAISE EXCEPTION 'pf: what a verification check covers is immutable' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- PENDING may be decided; a pass may lapse or be withdrawn; nothing else moves.
    IF NOT ((OLD.status = 'PENDING' AND NEW.status IN ('PASSED', 'FAILED'))
            OR (OLD.status = 'PASSED' AND NEW.status IN ('EXPIRED', 'REVOKED'))) THEN
      RAISE EXCEPTION 'pf: verification check cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER provider_verifications_guard BEFORE INSERT OR UPDATE ON provider_verifications
  FOR EACH ROW EXECUTE FUNCTION pf_provider_verification_guard();
CREATE TRIGGER provider_verifications_no_delete BEFORE DELETE ON provider_verifications
  FOR EACH ROW EXECUTE FUNCTION pf_reject_mutation();

-- A shop's level is always exactly what its passed checks say it is.
CREATE FUNCTION pf_provider_level_apply() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; computed text;
BEGIN
  target := COALESCE(NEW.shop_id, OLD.shop_id);
  SELECT CASE
    WHEN bool_or(kind = 'UNIVERSITY_REVIEW') THEN 'UNIVERSITY_APPROVED'
    WHEN bool_or(kind = 'MATRIC_NUMBER') THEN 'MATRIC_VERIFIED'
    WHEN bool_or(kind = 'STUDENT_EMAIL') THEN 'EMAIL_VERIFIED'
    ELSE 'UNVERIFIED' END
    INTO computed
    FROM provider_verifications WHERE shop_id = target AND status = 'PASSED';
  PERFORM set_config('pf.provider_level', 'on', true);
  UPDATE shops SET verification_level = COALESCE(computed, 'UNVERIFIED'), updated_at = now()
   WHERE id = target AND verification_level IS DISTINCT FROM COALESCE(computed, 'UNVERIFIED');
  PERFORM set_config('pf.provider_level', 'off', true);
  RETURN NULL;
END $$;
CREATE TRIGGER provider_verifications_level AFTER INSERT OR UPDATE ON provider_verifications
  FOR EACH ROW EXECUTE FUNCTION pf_provider_level_apply();

-- ---------------------------------------------------------------- shop guard
CREATE FUNCTION pf_shop_provider_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.verification_level IS DISTINCT FROM OLD.verification_level
     AND current_setting('pf.provider_level', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'pf: a shop''s verification level follows its checks and cannot be set directly' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'pf: a shop''s kind is fixed when it is registered' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.kind = 'STUDENT_RUN' THEN
    SELECT student_providers_allowed INTO allowed FROM universities WHERE id = NEW.university_id;
    IF NOT allowed THEN
      RAISE EXCEPTION 'pf: this university does not take student-run print shops' USING ERRCODE = 'P0010';
    END IF;
    -- A peer handling other students' documents must have accepted the confidentiality
    -- undertaking before any work can reach them.
    IF NEW.accepting_orders AND NEW.undertaking_accepted_at IS NULL THEN
      RAISE EXCEPTION 'pf: accept the confidentiality undertaking before taking orders' USING ERRCODE = 'P0011';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shops_provider_guard BEFORE INSERT OR UPDATE ON shops FOR EACH ROW EXECUTE FUNCTION pf_shop_provider_guard();

-- ---------------------------------------------------------------- confidentiality undertaking
-- Signed by the owner of a student-run shop, and again whenever the wording changes.
CREATE TABLE provider_undertakings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id       uuid NOT NULL,
  university_id uuid NOT NULL,
  user_id       uuid NOT NULL REFERENCES users (id),
  version       integer NOT NULL CHECK (version >= 1),
  -- SHA-256 of the exact wording accepted, so a later change is provable.
  text_sha256   text NOT NULL CHECK (text_sha256 ~ '^[a-f0-9]{64}$'),
  ip_address    inet,
  accepted_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, university_id) REFERENCES shops (id, university_id),
  UNIQUE (shop_id, user_id, version)
);
CREATE TRIGGER provider_undertakings_append_only BEFORE UPDATE OR DELETE ON provider_undertakings
  FOR EACH ROW EXECUTE FUNCTION pf_reject_mutation();

-- ---------------------------------------------------------------- student email codes
-- One-time codes sent to a provider's student email address. Only an HMAC is stored.
CREATE TABLE provider_email_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id       uuid NOT NULL,
  university_id uuid NOT NULL,
  email         text NOT NULL CHECK (length(email) BETWEEN 5 AND 254),
  code_hash     text NOT NULL CHECK (length(code_hash) = 64),
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts  integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, university_id) REFERENCES shops (id, university_id),
  CHECK (expires_at > created_at)
);
CREATE INDEX provider_email_codes_lookup ON provider_email_codes (shop_id, created_at DESC);

CREATE FUNCTION pf_provider_email_code_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.shop_id, NEW.email, NEW.code_hash, NEW.max_attempts, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.shop_id, OLD.email, OLD.code_hash, OLD.max_attempts, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'pf: provider email code % fields are immutable', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'pf: provider email code % is spent', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF NEW.consumed_at IS NOT NULL AND OLD.consumed_at IS NULL
     AND (OLD.revoked_at IS NOT NULL OR OLD.expires_at <= now() OR OLD.attempts >= OLD.max_attempts) THEN
    RAISE EXCEPTION 'pf: provider email code % cannot be used', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER provider_email_codes_guard BEFORE UPDATE ON provider_email_codes
  FOR EACH ROW EXECUTE FUNCTION pf_provider_email_code_guard();

-- ---------------------------------------------------------------- student roll (optional)
-- A university may upload its roll so matric numbers verify themselves. Only the matric
-- number and an HMAC of the surname are kept: enough to confirm "this matric belongs to
-- someone of this surname", and not a copy of the university's student register.
CREATE TABLE university_student_roll (
  university_id uuid NOT NULL REFERENCES universities (id) ON DELETE CASCADE,
  matric_number text NOT NULL CHECK (length(matric_number) BETWEEN 3 AND 40),
  surname_hash  text NOT NULL CHECK (surname_hash ~ '^[a-f0-9]{64}$'),
  -- Rows from an older upload are replaced wholesale, so a stale roll cannot linger.
  batch_id      uuid NOT NULL,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (university_id, matric_number)
);

-- ---------------------------------------------------------------- ordering limits
-- Students must be told, and must acknowledge, that a provider's identity is not fully
-- proven before their document reaches that provider.
ALTER TABLE orders ADD COLUMN unverified_ack_at timestamptz;

CREATE OR REPLACE FUNCTION pf_order_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q quotes%ROWTYPE;
DECLARE dv document_versions%ROWTYPE;
DECLARE sh shops%ROWTYPE;
DECLARE cap bigint;
BEGIN
  IF NEW.status <> 'AWAITING_PAYMENT' THEN
    RAISE EXCEPTION 'pf: orders must start AWAITING_PAYMENT' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO q FROM quotes WHERE id = NEW.quote_id;
  IF q.expires_at <= now() THEN
    RAISE EXCEPTION 'pf: quote % has expired', NEW.quote_id USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO dv FROM document_versions WHERE id = NEW.document_version_id;
  IF dv.processing_status <> 'READY' OR dv.files_purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'pf: document version % is not printable', NEW.document_version_id USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO sh FROM shops WHERE id = NEW.shop_id;
  IF sh.status <> 'APPROVED' OR NOT sh.accepting_orders THEN
    RAISE EXCEPTION 'pf: shop % is not accepting orders', NEW.shop_id USING ERRCODE = 'P0001';
  END IF;
  -- A student-run shop whose matric number is not yet verified carries extra risk: the
  -- order is capped, and the student must have been shown that and agreed.
  IF sh.kind = 'STUDENT_RUN' AND pf_provider_level_rank(sh.verification_level) < pf_provider_level_rank('MATRIC_VERIFIED') THEN
    IF NEW.unverified_ack_at IS NULL THEN
      RAISE EXCEPTION 'pf: this provider is not fully verified; the student must acknowledge that first' USING ERRCODE = 'P0012';
    END IF;
    SELECT student_provider_cap_kobo INTO cap FROM universities WHERE id = NEW.university_id;
    IF NEW.total_kobo > cap THEN
      RAISE EXCEPTION 'pf: orders at an unverified student provider are limited to % kobo', cap USING ERRCODE = 'P0013';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- existing shops
-- Every shop trading today was approved by its university after the usual checks, so that
-- decision is recorded as the review it was, and drives the level through the trigger.
INSERT INTO provider_verifications (shop_id, university_id, kind, status, subject, evidence, decided_by, decided_at, note)
SELECT s.id, s.university_id, 'UNIVERSITY_REVIEW', 'PASSED', s.name,
       jsonb_build_object('method', 'MIGRATED', 'approvedAt', s.approved_at),
       s.approved_by, s.approved_at, 'Recorded from the shop approval that predates provider verification'
  FROM shops s WHERE s.status = 'APPROVED' AND s.approved_at IS NOT NULL AND s.approved_by IS NOT NULL;

ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN (
  'DOCUMENT_SCAN', 'DOCUMENT_PROCESS', 'NOTIFY', 'QUOTE_EXPIRE', 'ORDER_EXPIRE',
  'RETENTION_PURGE', 'RECONCILE_PAYMENTS', 'REFUND_PROCESS', 'PRIVACY_EXPORT', 'PRIVACY_ERASE',
  'PROVIDER_REVERIFY'));
