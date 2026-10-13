-- PrintFlow 0006: phone verification and SMS sign-in codes, payment methods
-- (card, bank transfer, USSD), and shop power status.

-- ---------------------------------------------------------------- phone verification
-- Phones are stored in E.164 (+2348012345678). A phone counts for sign-in and
-- notifications only once a code sent to it has been entered.
ALTER TABLE users ADD COLUMN phone_verified_at timestamptz;
ALTER TABLE users ADD CONSTRAINT users_phone_verified_needs_phone CHECK (phone_verified_at IS NULL OR phone IS NOT NULL);

-- One-time codes sent by SMS. Only an HMAC of the code is stored. A code is tied to
-- the phone it was sent to and its purpose, expires quickly, burns after
-- max_attempts wrong guesses, and works once.
CREATE TABLE phone_otps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  user_id       uuid REFERENCES users (id) ON DELETE CASCADE,
  purpose       text NOT NULL CHECK (purpose IN ('VERIFY_PHONE', 'SIGN_IN')),
  code_hash     text NOT NULL CHECK (length(code_hash) = 64),
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts  integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX phone_otps_lookup ON phone_otps (phone, purpose, created_at DESC);

CREATE FUNCTION pf_phone_otp_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.phone, NEW.user_id, NEW.purpose, NEW.code_hash, NEW.max_attempts, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.phone, OLD.user_id, OLD.purpose, OLD.code_hash, OLD.max_attempts, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'pf: phone code % fields are immutable', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION 'pf: phone code % is spent', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF NEW.consumed_at IS NOT NULL AND OLD.consumed_at IS NULL
     AND (OLD.revoked_at IS NOT NULL OR OLD.expires_at <= now() OR OLD.attempts >= OLD.max_attempts) THEN
    RAISE EXCEPTION 'pf: phone code % cannot be used', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER phone_otps_guard BEFORE UPDATE ON phone_otps FOR EACH ROW EXECUTE FUNCTION pf_phone_otp_guard();

-- ---------------------------------------------------------------- payment methods
-- requested_channel: what the student chose at checkout (NULL = any).
-- channel: what the provider reports was actually used.
ALTER TABLE payments
  ADD COLUMN requested_channel text CHECK (requested_channel IN ('CARD', 'BANK_TRANSFER', 'USSD')),
  ADD COLUMN channel text CHECK (channel IN ('CARD', 'BANK_TRANSFER', 'USSD', 'BANK', 'QR', 'MOBILE_MONEY', 'OTHER'));

-- ---------------------------------------------------------------- shop power
-- Reported by staff, never sensed. OUTAGE may carry an expected return time.
ALTER TABLE shops
  ADD COLUMN power_status text NOT NULL DEFAULT 'UNKNOWN' CHECK (power_status IN ('UNKNOWN', 'GRID', 'GENERATOR', 'OUTAGE')),
  ADD COLUMN power_back_at timestamptz,
  ADD COLUMN power_note text CHECK (length(power_note) <= 140),
  ADD COLUMN power_updated_at timestamptz,
  ADD COLUMN power_updated_by uuid REFERENCES users (id);
ALTER TABLE shops ADD CONSTRAINT shops_power_back_only_when_out CHECK (power_back_at IS NULL OR power_status = 'OUTAGE');
