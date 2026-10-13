-- PrintFlow 0003: documents, processing jobs, quotes, orders, production, pickup.

CREATE TABLE document_assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  university_id uuid NOT NULL REFERENCES universities (id),
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_user_id, university_id) REFERENCES student_profiles (user_id, university_id),
  UNIQUE (id, university_id)
);
CREATE INDEX document_assets_owner_idx ON document_assets (owner_user_id, created_at DESC);

-- Each upload (including replacements) is a new immutable version.
CREATE TABLE document_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id         uuid NOT NULL,
  university_id    uuid NOT NULL,
  version_number   integer NOT NULL CHECK (version_number >= 1),
  -- Opaque server-generated key; never derived from the user's filename.
  storage_key      text NOT NULL UNIQUE CHECK (storage_key ~ '^docs/[0-9a-f-]{36}/[0-9a-f-]{36}$'),
  original_filename text NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 255),
  declared_mime    text NOT NULL,
  detected_type    text CHECK (detected_type IN ('PDF', 'DOCX')),
  byte_size        bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 52428800),
  sha256           text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  -- Rendered PDF used for printing (DOCX is converted; PDF is normalised).
  print_storage_key text CHECK (print_storage_key ~ '^print/[0-9a-f-]{36}/[0-9a-f-]{36}\.pdf$'),
  print_sha256     text CHECK (print_sha256 ~ '^[a-f0-9]{64}$'),
  page_count       integer CHECK (page_count BETWEEN 1 AND 2000),
  scan_status      text NOT NULL DEFAULT 'PENDING' CHECK (scan_status IN ('PENDING', 'CLEAN', 'INFECTED', 'ERROR')),
  processing_status text NOT NULL DEFAULT 'PENDING'
                   CHECK (processing_status IN ('PENDING', 'PROCESSING', 'READY', 'FAILED', 'REJECTED')),
  failure_reason   text CHECK (length(failure_reason) <= 500),
  files_purged_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (asset_id, university_id) REFERENCES document_assets (id, university_id),
  UNIQUE (asset_id, version_number),
  UNIQUE (id, university_id),
  UNIQUE (id, print_sha256),
  -- Only scanned, processed documents with a print rendition can be READY.
  CHECK (processing_status <> 'READY' OR (scan_status = 'CLEAN' AND page_count IS NOT NULL
         AND print_storage_key IS NOT NULL AND print_sha256 IS NOT NULL))
);

-- Content fields are write-once: set while PENDING/PROCESSING, frozen once READY.
CREATE FUNCTION pf_document_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.asset_id, NEW.university_id, NEW.version_number, NEW.storage_key, NEW.sha256, NEW.byte_size, NEW.original_filename)
     IS DISTINCT FROM ROW(OLD.id, OLD.asset_id, OLD.university_id, OLD.version_number, OLD.storage_key, OLD.sha256, OLD.byte_size, OLD.original_filename) THEN
    RAISE EXCEPTION 'pf: document version identity is immutable' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.processing_status = 'READY'
     AND ROW(NEW.print_storage_key, NEW.print_sha256, NEW.page_count, NEW.detected_type, NEW.scan_status, NEW.processing_status)
         IS DISTINCT FROM ROW(OLD.print_storage_key, OLD.print_sha256, OLD.page_count, OLD.detected_type, OLD.scan_status, OLD.processing_status) THEN
    RAISE EXCEPTION 'pf: processed document version % is immutable', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_versions_guard BEFORE UPDATE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION pf_document_version_guard();

-- Background work queue (Postgres-backed; workers use FOR UPDATE SKIP LOCKED).
CREATE TABLE jobs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('DOCUMENT_SCAN', 'DOCUMENT_PROCESS', 'NOTIFY', 'QUOTE_EXPIRE',
                                              'ORDER_EXPIRE', 'RETENTION_PURGE', 'RECONCILE_PAYMENTS')),
  payload       jsonb NOT NULL,
  dedupe_key    text UNIQUE,
  status        text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD')),
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts  integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  run_after     timestamptz NOT NULL DEFAULT now(),
  locked_by     text,
  locked_until  timestamptz,
  last_error    text CHECK (length(last_error) <= 2000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX jobs_ready_idx ON jobs (run_after, id) WHERE status = 'QUEUED';

-- Server-generated, time-limited price commitment.
CREATE TABLE quotes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id       uuid NOT NULL,
  shop_id             uuid NOT NULL,
  student_user_id     uuid NOT NULL,
  document_version_id uuid NOT NULL,
  document_sha256     text NOT NULL,
  rate_card_id        uuid NOT NULL,
  rate_card_version   integer NOT NULL,
  pricing_mode        text NOT NULL CHECK (pricing_mode IN ('UNIVERSITY_CONTROLLED', 'MERCHANT_CONTROLLED')),
  spec                jsonb NOT NULL,
  spec_hash           text NOT NULL CHECK (spec_hash ~ '^[a-f0-9]{64}$'),
  lines               jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array'),
  subtotal_kobo       bigint NOT NULL CHECK (subtotal_kobo >= 0),
  service_fee_kobo    bigint NOT NULL CHECK (service_fee_kobo >= 0),
  total_kobo          bigint NOT NULL CHECK (total_kobo > 0),
  total_sheets        integer NOT NULL CHECK (total_sheets > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  FOREIGN KEY (shop_id, university_id) REFERENCES shops (id, university_id),
  FOREIGN KEY (student_user_id, university_id) REFERENCES student_profiles (user_id, university_id),
  FOREIGN KEY (document_version_id, university_id) REFERENCES document_versions (id, university_id),
  FOREIGN KEY (document_version_id, document_sha256) REFERENCES document_versions (id, print_sha256),
  FOREIGN KEY (rate_card_id, university_id) REFERENCES rate_cards (id, university_id),
  CHECK (total_kobo = subtotal_kobo + service_fee_kobo),
  CHECK (expires_at > created_at),
  -- Composite key target so an order can be pinned to exactly this price.
  UNIQUE (id, total_kobo, spec_hash, document_version_id, shop_id, student_user_id)
);
CREATE INDEX quotes_student_idx ON quotes (student_user_id, created_at DESC);

-- Quotes are immutable once issued.
CREATE TRIGGER quotes_immutable BEFORE UPDATE ON quotes FOR EACH ROW EXECUTE FUNCTION pf_reject_mutation();

CREATE TABLE orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           text NOT NULL UNIQUE CHECK (reference ~ '^PF-[0-9A-Z]{8}$'),
  university_id       uuid NOT NULL,
  shop_id             uuid NOT NULL,
  student_user_id     uuid NOT NULL,
  pickup_location_id  uuid NOT NULL,
  quote_id            uuid NOT NULL UNIQUE,
  document_version_id uuid NOT NULL,
  spec_hash           text NOT NULL,
  -- Frozen agreed price. Equals the quote by composite FK below.
  total_kobo          bigint NOT NULL CHECK (total_kobo > 0),
  status              text NOT NULL DEFAULT 'AWAITING_PAYMENT',
  status_changed_at   timestamptz NOT NULL DEFAULT now(),
  -- Monotonic version for optimistic concurrency on state changes.
  row_version         integer NOT NULL DEFAULT 1,
  payment_due_at      timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, university_id) REFERENCES shops (id, university_id),
  FOREIGN KEY (student_user_id, university_id) REFERENCES student_profiles (user_id, university_id),
  FOREIGN KEY (pickup_location_id, shop_id) REFERENCES pickup_locations (id, shop_id),
  FOREIGN KEY (quote_id, total_kobo, spec_hash, document_version_id, shop_id, student_user_id)
    REFERENCES quotes (id, total_kobo, spec_hash, document_version_id, shop_id, student_user_id),
  UNIQUE (id, university_id),
  UNIQUE (id, shop_id)
);
CREATE INDEX orders_student_idx ON orders (student_user_id, created_at DESC);
CREATE INDEX orders_shop_status_idx ON orders (shop_id, status, status_changed_at);
CREATE INDEX orders_university_idx ON orders (university_id, created_at DESC);

-- Legal transitions; must equal ORDER_TRANSITIONS in packages/domain (tested).
CREATE TABLE order_status_transitions (
  from_status text NOT NULL,
  to_status   text NOT NULL,
  PRIMARY KEY (from_status, to_status)
);
INSERT INTO order_status_transitions (from_status, to_status) VALUES
  ('AWAITING_PAYMENT', 'PAID'), ('AWAITING_PAYMENT', 'CANCELLED'), ('AWAITING_PAYMENT', 'EXPIRED'),
  ('PAID', 'ACCEPTED'), ('PAID', 'REJECTED'), ('PAID', 'REFUND_PENDING'), ('REJECTED', 'REFUND_PENDING'),
  ('ACCEPTED', 'PRINTING'), ('PRINTING', 'PAUSED'), ('PAUSED', 'PRINTING'),
  ('PRINTING', 'PRINT_FAILED'), ('PAUSED', 'PRINT_FAILED'), ('PRINT_FAILED', 'PRINTING'),
  ('PRINT_FAILED', 'REFUND_PENDING'), ('PRINTING', 'QUALITY_CHECK'),
  ('QUALITY_CHECK', 'READY_FOR_PICKUP'), ('QUALITY_CHECK', 'PRINTING'),
  ('READY_FOR_PICKUP', 'COLLECTED'), ('REFUND_PENDING', 'REFUNDED');

CREATE TRIGGER order_status_transitions_readonly BEFORE INSERT OR UPDATE OR DELETE ON order_status_transitions
  FOR EACH ROW EXECUTE FUNCTION pf_reject_mutation();

CREATE FUNCTION pf_order_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q quotes%ROWTYPE;
DECLARE dv document_versions%ROWTYPE;
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
  IF NOT EXISTS (SELECT 1 FROM shops s WHERE s.id = NEW.shop_id AND s.status = 'APPROVED' AND s.accepting_orders) THEN
    RAISE EXCEPTION 'pf: shop % is not accepting orders', NEW.shop_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_insert_guard BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION pf_order_insert_guard();

CREATE FUNCTION pf_order_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.reference, NEW.university_id, NEW.shop_id, NEW.student_user_id, NEW.quote_id,
         NEW.document_version_id, NEW.spec_hash, NEW.total_kobo, NEW.created_at, NEW.pickup_location_id, NEW.payment_due_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.reference, OLD.university_id, OLD.shop_id, OLD.student_user_id, OLD.quote_id,
         OLD.document_version_id, OLD.spec_hash, OLD.total_kobo, OLD.created_at, OLD.pickup_location_id, OLD.payment_due_at) THEN
    RAISE EXCEPTION 'pf: order % terms are frozen', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT EXISTS (SELECT 1 FROM order_status_transitions WHERE from_status = OLD.status AND to_status = NEW.status) THEN
      RAISE EXCEPTION 'pf: illegal order transition % -> %', OLD.status, NEW.status USING ERRCODE = 'P0003';
    END IF;
    NEW.status_changed_at := now();
    NEW.row_version := OLD.row_version + 1;
  ELSIF NEW.row_version IS DISTINCT FROM OLD.row_version THEN
    RAISE EXCEPTION 'pf: row_version is managed by the database' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_update_guard BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION pf_order_update_guard();
CREATE TRIGGER orders_no_delete BEFORE DELETE ON orders FOR EACH ROW EXECUTE FUNCTION pf_reject_mutation();

-- Every status change, with actor and reason.
CREATE TABLE order_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id      uuid NOT NULL,
  university_id uuid NOT NULL,
  from_status   text,
  to_status     text NOT NULL,
  actor_kind    text NOT NULL CHECK (actor_kind IN ('STUDENT', 'SHOP_STAFF', 'UNIVERSITY_ADMIN', 'PLATFORM_ADMIN', 'SYSTEM')),
  actor_user_id uuid REFERENCES users (id),
  device_id     uuid REFERENCES devices (id),
  reason        text CHECK (length(reason) <= 1000),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (order_id, university_id) REFERENCES orders (id, university_id)
);
CREATE INDEX order_events_order_idx ON order_events (order_id, id);
CREATE TRIGGER order_events_append_only BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION pf_reject_mutation();

-- Shop work queue. One entry per paid order; ordering by priority then time.
CREATE TABLE queue_entries (
  order_id     uuid PRIMARY KEY,
  shop_id      uuid NOT NULL,
  priority     smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN -10 AND 10),
  enqueued_at  timestamptz NOT NULL DEFAULT now(),
  device_id    uuid,
  claimed_by   uuid REFERENCES users (id),
  claimed_at   timestamptz,
  FOREIGN KEY (order_id, shop_id) REFERENCES orders (id, shop_id),
  FOREIGN KEY (device_id, shop_id) REFERENCES devices (id, shop_id)
);
CREATE INDEX queue_shop_order_idx ON queue_entries (shop_id, priority DESC, enqueued_at, order_id);

CREATE TABLE quality_checks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL,
  shop_id       uuid NOT NULL,
  checked_by    uuid NOT NULL REFERENCES users (id),
  result        text NOT NULL CHECK (result IN ('PASS', 'FAIL')),
  issues        text[] NOT NULL DEFAULT '{}' CHECK (issues <@ ARRAY[
                  'PAGE_COUNT_MISMATCH', 'WRONG_PAPER_SIZE', 'WRONG_COLOUR_MODE', 'WRONG_SIDES',
                  'MISSING_PAGES', 'PRINT_DEFECT', 'FINISHING_DEFECT', 'OTHER']::text[]),
  sheets_counted integer CHECK (sheets_counted >= 0),
  notes         text CHECK (length(notes) <= 1000),
  checked_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (order_id, shop_id) REFERENCES orders (id, shop_id),
  CHECK (result = 'PASS' OR cardinality(issues) > 0)
);

CREATE TABLE pickup_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES orders (id),
  code_hash       text NOT NULL CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  expires_at      timestamptz NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  used_at         timestamptz,
  used_by         uuid REFERENCES users (id),
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (used_at IS NULL OR used_by IS NOT NULL),
  CHECK (NOT (used_at IS NOT NULL AND revoked_at IS NOT NULL))
);
-- At most one live code per order; a used code can never be reset.
CREATE UNIQUE INDEX pickup_one_live_per_order ON pickup_tokens (order_id) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX pickup_one_use_per_order ON pickup_tokens (order_id) WHERE used_at IS NOT NULL;

CREATE FUNCTION pf_pickup_token_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.used_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'pf: pickup token % is spent', OLD.id USING ERRCODE = 'P0004';
  END IF;
  IF NEW.code_hash <> OLD.code_hash OR NEW.order_id <> OLD.order_id OR NEW.expires_at <> OLD.expires_at
     OR NEW.failed_attempts < OLD.failed_attempts THEN
    RAISE EXCEPTION 'pf: pickup token % fields are immutable', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF NEW.used_at IS NOT NULL AND (NEW.used_at >= OLD.expires_at OR OLD.failed_attempts >= 5) THEN
    RAISE EXCEPTION 'pf: pickup token % cannot be redeemed', OLD.id USING ERRCODE = 'P0004';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pickup_tokens_guard BEFORE UPDATE ON pickup_tokens FOR EACH ROW EXECUTE FUNCTION pf_pickup_token_guard();
