-- PrintFlow 0001: identity, tenancy, staff memberships, devices, audit log.
-- Every tenant-owned row carries university_id. Child rows reference parents
-- through composite (id, university_id) foreign keys so a row can never point
-- at a parent in another university.

CREATE TABLE universities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 200),
  status           text NOT NULL DEFAULT 'ONBOARDING' CHECK (status IN ('ONBOARDING', 'ACTIVE', 'SUSPENDED')),
  pricing_mode     text NOT NULL DEFAULT 'UNIVERSITY_CONTROLLED'
                   CHECK (pricing_mode IN ('UNIVERSITY_CONTROLLED', 'MERCHANT_CONTROLLED')),
  -- Platform fee for orders at this university.
  service_fee_fixed_kobo bigint NOT NULL DEFAULT 0 CHECK (service_fee_fixed_kobo >= 0),
  service_fee_bps  integer NOT NULL DEFAULT 0 CHECK (service_fee_bps BETWEEN 0 AND 10000),
  quote_ttl_seconds integer NOT NULL DEFAULT 1800 CHECK (quote_ttl_seconds BETWEEN 60 AND 86400),
  -- Days to keep document files after an order reaches a terminal state.
  document_retention_days integer NOT NULL DEFAULT 30 CHECK (document_retention_days BETWEEN 1 AND 365),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campuses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id uuid NOT NULL REFERENCES universities (id) ON DELETE RESTRICT,
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 200),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (university_id, name),
  UNIQUE (id, university_id)
);

CREATE TABLE departments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id uuid NOT NULL,
  campus_id     uuid NOT NULL,
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 200),
  FOREIGN KEY (campus_id, university_id) REFERENCES campuses (id, university_id),
  UNIQUE (campus_id, name),
  UNIQUE (id, university_id)
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone          text CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  full_name      text NOT NULL CHECK (length(full_name) BETWEEN 2 AND 200),
  -- argon2id hash; never a raw password.
  password_hash  text NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
  email_verified_at timestamptz,
  platform_role  text CHECK (platform_role IN ('PLATFORM_ADMIN', 'PLATFORM_SUPPORT')),
  status         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'LOCKED', 'DISABLED', 'DELETED')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (email) WHERE status <> 'DELETED';
CREATE UNIQUE INDEX users_phone_uq ON users (phone) WHERE phone IS NOT NULL AND status <> 'DELETED';

CREATE TABLE student_profiles (
  user_id        uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  university_id  uuid NOT NULL REFERENCES universities (id),
  campus_id      uuid NOT NULL,
  department_id  uuid,
  matric_number  text CHECK (length(matric_number) BETWEEN 3 AND 40),
  FOREIGN KEY (campus_id, university_id) REFERENCES campuses (id, university_id),
  FOREIGN KEY (department_id, university_id) REFERENCES departments (id, university_id),
  UNIQUE (user_id, university_id)
);
CREATE UNIQUE INDEX student_matric_uq ON student_profiles (university_id, matric_number) WHERE matric_number IS NOT NULL;

CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- SHA-256 of the opaque session token; the token itself is never stored.
  token_hash      bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  mfa_verified_at timestamptz,
  ip_address      inet,
  user_agent      text CHECK (length(user_agent) <= 512),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE mfa_factors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('TOTP')),
  -- Encrypted with an application key (AES-256-GCM); never plaintext.
  secret_ciphertext bytea NOT NULL,
  confirmed_at     timestamptz,
  last_used_step   bigint,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mfa_one_totp_per_user ON mfa_factors (user_id) WHERE kind = 'TOTP';

CREATE TABLE account_recovery_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('PASSWORD_RESET', 'EMAIL_VERIFY')),
  token_hash  bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours')
);

CREATE TABLE university_staff (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  university_id uuid NOT NULL REFERENCES universities (id),
  role          text NOT NULL CHECK (role IN ('UNIVERSITY_ADMIN', 'UNIVERSITY_FINANCE', 'UNIVERSITY_SUPPORT')),
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX university_staff_active_uq ON university_staff (user_id, university_id) WHERE revoked_at IS NULL;

CREATE TABLE shops (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id   uuid NOT NULL REFERENCES universities (id),
  campus_id       uuid NOT NULL,
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  status          text NOT NULL DEFAULT 'PENDING_APPROVAL'
                  CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'SUSPENDED', 'REMOVED')),
  accepting_orders boolean NOT NULL DEFAULT false,
  location_note   text CHECK (length(location_note) <= 500),
  -- { "mon": [["08:00","18:00"]], ... } validated by the API.
  opening_hours   jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(opening_hours) = 'object'),
  approved_at     timestamptz,
  approved_by     uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (campus_id, university_id) REFERENCES campuses (id, university_id),
  UNIQUE (id, university_id),
  UNIQUE (university_id, name),
  -- A shop cannot take orders unless approved.
  CHECK (NOT accepting_orders OR status = 'APPROVED'),
  CHECK (status <> 'APPROVED' OR (approved_at IS NOT NULL AND approved_by IS NOT NULL))
);

CREATE TABLE pickup_locations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id uuid NOT NULL,
  shop_id       uuid NOT NULL,
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 200),
  is_active     boolean NOT NULL DEFAULT true,
  FOREIGN KEY (shop_id, university_id) REFERENCES shops (id, university_id),
  UNIQUE (id, university_id),
  UNIQUE (id, shop_id)
);

CREATE TABLE shop_memberships (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  shop_id       uuid NOT NULL,
  university_id uuid NOT NULL,
  role          text NOT NULL CHECK (role IN ('OWNER', 'MANAGER', 'OPERATOR')),
  permissions   text[] NOT NULL DEFAULT '{}' CHECK (permissions <@ ARRAY[
                  'orders.view', 'orders.accept', 'orders.produce', 'orders.qa', 'orders.collect',
                  'documents.download', 'devices.manage', 'catalogue.manage', 'pricing.manage',
                  'staff.manage', 'reports.view']::text[]),
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, university_id) REFERENCES shops (id, university_id)
);
CREATE UNIQUE INDEX shop_membership_active_uq ON shop_memberships (user_id, shop_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX shop_one_active_owner ON shop_memberships (shop_id) WHERE role = 'OWNER' AND revoked_at IS NULL;

CREATE TABLE devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id       uuid NOT NULL,
  university_id uuid NOT NULL,
  label         text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  capabilities  jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Manually reported by staff; PrintFlow never claims live device telemetry.
  reported_status text NOT NULL DEFAULT 'UNKNOWN'
                  CHECK (reported_status IN ('UNKNOWN', 'AVAILABLE', 'BUSY', 'OUT_OF_PAPER', 'OUT_OF_TONER', 'FAULT', 'OFFLINE')),
  status_reported_at timestamptz,
  status_reported_by uuid REFERENCES users (id),
  FOREIGN KEY (shop_id, university_id) REFERENCES shops (id, university_id),
  UNIQUE (shop_id, label),
  UNIQUE (id, shop_id)
);

-- Append-only audit trail for privileged and financial actions.
CREATE TABLE audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  university_id uuid REFERENCES universities (id),
  shop_id       uuid,
  actor_user_id uuid REFERENCES users (id),
  actor_kind    text NOT NULL CHECK (actor_kind IN ('STUDENT', 'SHOP_STAFF', 'UNIVERSITY_ADMIN', 'PLATFORM_ADMIN', 'SYSTEM')),
  action        text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.]{2,80}$'),
  entity_type   text NOT NULL,
  entity_id     text NOT NULL,
  request_id    text,
  ip_address    inet,
  -- Redacted before insert: no document contents, codes, tokens or secrets.
  details       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_university_time_idx ON audit_log (university_id, occurred_at DESC);
CREATE INDEX audit_entity_idx ON audit_log (entity_type, entity_id);

CREATE FUNCTION pf_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pf: % is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION pf_reject_mutation();
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION pf_reject_mutation();

CREATE FUNCTION pf_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER universities_touch BEFORE UPDATE ON universities FOR EACH ROW EXECUTE FUNCTION pf_touch_updated_at();
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION pf_touch_updated_at();
CREATE TRIGGER shops_touch BEFORE UPDATE ON shops FOR EACH ROW EXECUTE FUNCTION pf_touch_updated_at();
