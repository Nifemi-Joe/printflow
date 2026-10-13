-- PrintFlow 0004: payments, webhook inbox, refunds, disputes, settlements, idempotency.

-- Needed for the settlement non-overlap exclusion constraint (trusted extension).
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL,
  university_id      uuid NOT NULL,
  provider           text NOT NULL CHECK (provider IN ('PAYSTACK', 'TEST')),
  -- Our reference sent to the provider; unique per provider.
  provider_reference text NOT NULL,
  amount_kobo        bigint NOT NULL CHECK (amount_kobo > 0),
  currency           text NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  status             text NOT NULL DEFAULT 'INITIATED' CHECK (status IN ('INITIATED', 'SUCCEEDED', 'FAILED', 'ABANDONED')),
  -- Amount the provider reported; must equal amount_kobo for SUCCEEDED.
  confirmed_amount_kobo bigint,
  confirmed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (order_id, university_id) REFERENCES orders (id, university_id),
  UNIQUE (provider, provider_reference),
  UNIQUE (id, university_id),
  CHECK (status <> 'SUCCEEDED' OR (confirmed_at IS NOT NULL AND confirmed_amount_kobo = amount_kobo))
);
-- An order can be paid successfully at most once.
CREATE UNIQUE INDEX payments_one_success_per_order ON payments (order_id) WHERE status = 'SUCCEEDED';

CREATE FUNCTION pf_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_total bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT total_kobo INTO order_total FROM orders WHERE id = NEW.order_id;
    IF NEW.amount_kobo <> order_total THEN
      RAISE EXCEPTION 'pf: payment amount % does not equal order total %', NEW.amount_kobo, order_total USING ERRCODE = 'P0005';
    END IF;
    IF NEW.status <> 'INITIATED' THEN
      RAISE EXCEPTION 'pf: payments must start INITIATED' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.order_id, NEW.provider, NEW.provider_reference, NEW.amount_kobo, NEW.university_id)
     IS DISTINCT FROM ROW(OLD.order_id, OLD.provider, OLD.provider_reference, OLD.amount_kobo, OLD.university_id) THEN
    RAISE EXCEPTION 'pf: payment identity is immutable' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('SUCCEEDED', 'FAILED', 'ABANDONED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'pf: payment % is final (%)', OLD.id, OLD.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_guard BEFORE INSERT OR UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION pf_payment_guard();
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments FOR EACH ROW EXECUTE FUNCTION pf_reject_mutation();

-- Inbox for provider webhooks. The unique key makes duplicate deliveries no-ops.
CREATE TABLE payment_webhook_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider       text NOT NULL,
  event_id       text NOT NULL,
  event_type     text NOT NULL,
  signature_valid boolean NOT NULL,
  payload        jsonb NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz,
  processing_error text CHECK (length(processing_error) <= 2000),
  UNIQUE (provider, event_id)
);

CREATE TABLE refunds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id     uuid NOT NULL,
  order_id       uuid NOT NULL,
  university_id  uuid NOT NULL,
  amount_kobo    bigint NOT NULL CHECK (amount_kobo > 0),
  reason         text NOT NULL CHECK (length(reason) BETWEEN 3 AND 1000),
  status         text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'PROCESSING', 'SUCCEEDED', 'FAILED')),
  idempotency_key text NOT NULL UNIQUE,
  provider_refund_reference text UNIQUE,
  requested_by   uuid REFERENCES users (id),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  FOREIGN KEY (payment_id, university_id) REFERENCES payments (id, university_id),
  FOREIGN KEY (order_id, university_id) REFERENCES orders (id, university_id)
);

-- Refunds (excluding failed ones) can never exceed what was successfully paid.
CREATE FUNCTION pf_refund_cap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paid bigint; pay_status text; pay_order uuid; committed bigint;
BEGIN
  -- Lock the payment row so concurrent refund requests serialise here.
  SELECT amount_kobo, status, order_id INTO paid, pay_status, pay_order FROM payments WHERE id = NEW.payment_id FOR UPDATE;
  IF pay_status <> 'SUCCEEDED' THEN
    RAISE EXCEPTION 'pf: cannot refund a payment that has not succeeded' USING ERRCODE = 'P0006';
  END IF;
  IF pay_order <> NEW.order_id THEN
    RAISE EXCEPTION 'pf: refund order does not match payment order' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(sum(amount_kobo), 0) INTO committed FROM refunds
    WHERE payment_id = NEW.payment_id AND status <> 'FAILED' AND id <> NEW.id;
  IF NEW.status <> 'FAILED' AND committed + NEW.amount_kobo > paid THEN
    RAISE EXCEPTION 'pf: refunds % would exceed payment %', committed + NEW.amount_kobo, paid USING ERRCODE = 'P0006';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(NEW.payment_id, NEW.order_id, NEW.amount_kobo) IS DISTINCT FROM ROW(OLD.payment_id, OLD.order_id, OLD.amount_kobo) THEN
    RAISE EXCEPTION 'pf: refund identity is immutable' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('SUCCEEDED', 'FAILED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'pf: refund % is final', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refunds_cap BEFORE INSERT OR UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION pf_refund_cap();
CREATE TRIGGER refunds_no_delete BEFORE DELETE ON refunds FOR EACH ROW EXECUTE FUNCTION pf_reject_mutation();

CREATE TABLE disputes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL,
  university_id  uuid NOT NULL,
  opened_by      uuid NOT NULL REFERENCES users (id),
  category       text NOT NULL CHECK (category IN ('QUALITY', 'NOT_RECEIVED', 'WRONG_SPEC', 'OVERCHARGED', 'OTHER')),
  description    text NOT NULL CHECK (length(description) BETWEEN 10 AND 4000),
  status         text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'UNDER_REVIEW', 'RESOLVED_REFUND', 'RESOLVED_REPRINT', 'RESOLVED_NO_ACTION', 'WITHDRAWN')),
  resolution_note text CHECK (length(resolution_note) <= 4000),
  resolved_by    uuid REFERENCES users (id),
  opened_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  FOREIGN KEY (order_id, university_id) REFERENCES orders (id, university_id),
  CHECK (status IN ('OPEN', 'UNDER_REVIEW', 'WITHDRAWN') OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL))
);
CREATE UNIQUE INDEX disputes_one_open_per_order ON disputes (order_id) WHERE status IN ('OPEN', 'UNDER_REVIEW');

-- Periodic payout of collected order value to a shop.
CREATE TABLE settlements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        uuid NOT NULL,
  university_id  uuid NOT NULL,
  period_start   timestamptz NOT NULL,
  period_end     timestamptz NOT NULL,
  gross_kobo     bigint NOT NULL CHECK (gross_kobo >= 0),
  fees_kobo      bigint NOT NULL CHECK (fees_kobo >= 0),
  refunds_kobo   bigint NOT NULL CHECK (refunds_kobo >= 0),
  net_kobo       bigint NOT NULL,
  status         text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'PAID_OUT', 'VOID')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, university_id) REFERENCES shops (id, university_id),
  CHECK (period_end > period_start),
  CHECK (net_kobo = gross_kobo - fees_kobo - refunds_kobo),
  EXCLUDE USING gist (shop_id WITH =, tstzrange(period_start, period_end) WITH &&) WHERE (status <> 'VOID')
);

-- Idempotency for mutating API requests (order creation, payment initiation, refunds).
CREATE TABLE idempotency_keys (
  user_id       uuid NOT NULL REFERENCES users (id),
  key           text NOT NULL CHECK (length(key) BETWEEN 16 AND 128),
  request_hash  text NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
