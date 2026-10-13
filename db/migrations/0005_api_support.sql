-- PrintFlow 0005: support for the HTTP API and worker.
-- Login lockout, notifications, privacy requests, previews, rate limits,
-- reprint linkage and additional job kinds.

-- Brute-force protection on login.
ALTER TABLE users
  ADD COLUMN failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  ADD COLUMN locked_until timestamptz;

-- Rendered PNG previews of the print rendition: preview/<asset>/<version>/<n>.png
-- scan_engine records which scanner produced scan_status (e.g. "clamav 1.4.1/27420"),
-- so a development-only "none" scan can never be mistaken for a real one.
ALTER TABLE document_versions
  ADD COLUMN preview_pages integer CHECK (preview_pages BETWEEN 0 AND 10),
  ADD COLUMN scan_engine text CHECK (length(scan_engine) <= 120),
  ADD COLUMN page_size text CHECK (page_size IN ('A4', 'A3', 'A5', 'LETTER', 'LEGAL', 'OTHER'));

-- A reprint is a new order (new quote, new payment) linked to the original.
ALTER TABLE orders ADD COLUMN reprint_of_order_id uuid REFERENCES orders (id);
ALTER TABLE orders ADD CONSTRAINT orders_not_self_reprint CHECK (reprint_of_order_id IS DISTINCT FROM id);

CREATE OR REPLACE FUNCTION pf_order_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.reference, NEW.university_id, NEW.shop_id, NEW.student_user_id, NEW.quote_id,
         NEW.document_version_id, NEW.spec_hash, NEW.total_kobo, NEW.created_at, NEW.pickup_location_id,
         NEW.payment_due_at, NEW.reprint_of_order_id)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.reference, OLD.university_id, OLD.shop_id, OLD.student_user_id, OLD.quote_id,
         OLD.document_version_id, OLD.spec_hash, OLD.total_kobo, OLD.created_at, OLD.pickup_location_id,
         OLD.payment_due_at, OLD.reprint_of_order_id) THEN
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

ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN (
  'DOCUMENT_SCAN', 'DOCUMENT_PROCESS', 'NOTIFY', 'QUOTE_EXPIRE', 'ORDER_EXPIRE',
  'RETENTION_PURGE', 'RECONCILE_PAYMENTS', 'REFUND_PROCESS', 'PRIVACY_EXPORT', 'PRIVACY_ERASE'));

-- In-app notifications; email/SMS delivery is queued as NOTIFY jobs.
CREATE TABLE notifications (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.]{2,60}$'),
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 140),
  body        text NOT NULL CHECK (length(body) <= 1000),
  order_id    uuid REFERENCES orders (id),
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, id DESC);

-- Data-subject requests (export / erasure), handled by university admins.
CREATE TABLE privacy_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id),
  university_id uuid REFERENCES universities (id),
  kind          text NOT NULL CHECK (kind IN ('EXPORT', 'ERASURE')),
  status        text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'IN_PROGRESS', 'COMPLETED', 'REJECTED')),
  note          text CHECK (length(note) <= 2000),
  -- Private object holding a completed export (exports/<user>/<uuid>.json).
  export_storage_key text CHECK (export_storage_key ~ '^exports/[0-9a-f-]{36}/[0-9a-f-]{36}\.json$'),
  handled_by    uuid REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  CHECK (status NOT IN ('COMPLETED', 'REJECTED') OR completed_at IS NOT NULL)
);
CREATE UNIQUE INDEX privacy_one_open_per_kind ON privacy_requests (user_id, kind) WHERE status IN ('RECEIVED', 'IN_PROGRESS');

-- Fixed-window rate limiting shared across API instances.
CREATE UNLOGGED TABLE rate_limit_counters (
  bucket       text NOT NULL,
  window_start timestamptz NOT NULL,
  hits         integer NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
