-- PrintFlow 0007: student wallet.
--
-- A closed-loop, spend-only balance. Students top it up and spend it on printing; it
-- cannot be withdrawn or transferred. Two buckets:
--   CASH  - money the student paid in (top-ups) and refunds of what they paid;
--   PROMO - credit granted by the university (welcome credit, rewards). Promo is spent
--           first, is never converted to cash, and returns to promo when refunded.
-- Every change is an append-only ledger entry. Balances are maintained by trigger in
-- the same transaction and can never go negative.

-- ---------------------------------------------------------------- settings
ALTER TABLE universities
  ADD COLUMN welcome_credit_kobo bigint NOT NULL DEFAULT 0 CHECK (welcome_credit_kobo BETWEEN 0 AND 500000);

-- ---------------------------------------------------------------- balances
CREATE TABLE wallets (
  user_id        uuid PRIMARY KEY,
  university_id  uuid NOT NULL,
  cash_kobo      bigint NOT NULL DEFAULT 0 CHECK (cash_kobo >= 0),
  promo_kobo     bigint NOT NULL DEFAULT 0 CHECK (promo_kobo >= 0),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id, university_id) REFERENCES student_profiles (user_id, university_id),
  -- Hard ceiling; the configured limit (WALLET_MAX_BALANCE_KOBO) is lower.
  CHECK (cash_kobo + promo_kobo <= 100000000)
);

-- Balances change only through ledger entries.
CREATE FUNCTION pf_wallet_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND (NEW.cash_kobo <> 0 OR NEW.promo_kobo <> 0) THEN
    RAISE EXCEPTION 'pf: wallets start empty' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.university_id IS DISTINCT FROM OLD.university_id THEN
      RAISE EXCEPTION 'pf: wallet owner is immutable' USING ERRCODE = 'P0001';
    END IF;
    IF current_setting('pf.wallet_ledger', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'pf: wallet balances change only through wallet_entries' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wallets_guard BEFORE INSERT OR UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION pf_wallet_guard();
CREATE TRIGGER wallets_no_delete BEFORE DELETE ON wallets FOR EACH ROW EXECUTE FUNCTION pf_reject_mutation();

-- ---------------------------------------------------------------- top-ups
CREATE TABLE wallet_topups (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES wallets (user_id),
  university_id      uuid NOT NULL,
  provider           text NOT NULL CHECK (provider IN ('PAYSTACK', 'TEST')),
  provider_reference text NOT NULL,
  amount_kobo        bigint NOT NULL CHECK (amount_kobo BETWEEN 10000 AND 50000000),
  currency           text NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  status             text NOT NULL DEFAULT 'INITIATED' CHECK (status IN ('INITIATED', 'SUCCEEDED', 'FAILED', 'ABANDONED')),
  requested_channel  text CHECK (requested_channel IN ('CARD', 'BANK_TRANSFER', 'USSD')),
  channel            text CHECK (channel IN ('CARD', 'BANK_TRANSFER', 'USSD', 'BANK', 'QR', 'MOBILE_MONEY', 'OTHER')),
  confirmed_amount_kobo bigint,
  confirmed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_reference),
  FOREIGN KEY (user_id, university_id) REFERENCES student_profiles (user_id, university_id),
  CHECK (status <> 'SUCCEEDED' OR (confirmed_at IS NOT NULL AND confirmed_amount_kobo = amount_kobo))
);
CREATE INDEX wallet_topups_user_idx ON wallet_topups (user_id, created_at DESC);

CREATE FUNCTION pf_topup_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'INITIATED' THEN
      RAISE EXCEPTION 'pf: top-ups must start INITIATED' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.user_id, NEW.university_id, NEW.provider, NEW.provider_reference, NEW.amount_kobo)
     IS DISTINCT FROM ROW(OLD.user_id, OLD.university_id, OLD.provider, OLD.provider_reference, OLD.amount_kobo) THEN
    RAISE EXCEPTION 'pf: top-up identity is immutable' USING ERRCODE = 'P0001';
  END IF;
  -- A top-up the student walked away from (or that first reported a failure) can
  -- still be paid at the provider; that money must still reach the wallet.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'INITIATED' OR (OLD.status IN ('ABANDONED', 'FAILED') AND NEW.status = 'SUCCEEDED')
              OR (OLD.status = 'ABANDONED' AND NEW.status = 'FAILED')) THEN
    RAISE EXCEPTION 'pf: top-up % is final (%)', OLD.id, OLD.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wallet_topups_guard BEFORE INSERT OR UPDATE ON wallet_topups FOR EACH ROW EXECUTE FUNCTION pf_topup_guard();
CREATE TRIGGER wallet_topups_no_delete BEFORE DELETE ON wallet_topups FOR EACH ROW EXECUTE FUNCTION pf_reject_mutation();

-- ---------------------------------------------------------------- refunds
-- PROVIDER: back to the card or bank through the payment provider (days).
-- WALLET:   to the student's wallet as cash, instantly; recorded SUCCEEDED at once.
ALTER TABLE refunds ADD COLUMN destination text NOT NULL DEFAULT 'PROVIDER' CHECK (destination IN ('PROVIDER', 'WALLET'));
ALTER TABLE refunds ADD CONSTRAINT refunds_wallet_is_instant CHECK (destination = 'PROVIDER' OR (status = 'SUCCEEDED' AND completed_at IS NOT NULL));

-- ---------------------------------------------------------------- ledger
CREATE TABLE wallet_entries (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES wallets (user_id),
  university_id   uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN (
                    'TOPUP',             -- cash in from a top-up
                    'ORDER_PAYMENT',     -- balance applied to an order
                    'ORDER_RETURN',      -- balance given back from an order (cancelled, expired, refunded)
                    'CARD_REFUND',       -- card/bank money from an order refunded into the wallet
                    'UNMATCHED_PAYMENT', -- money for a payment link the student had abandoned
                    'PROMO_GRANT', 'WELCOME_CREDIT', 'PROMO_REVOKE')),
  cash_kobo       bigint NOT NULL DEFAULT 0,
  promo_kobo      bigint NOT NULL DEFAULT 0,
  order_id        uuid,
  topup_id        uuid REFERENCES wallet_topups (id),
  refund_id       uuid REFERENCES refunds (id),
  payment_id      uuid REFERENCES payments (id),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  note            text CHECK (length(note) <= 500),
  created_by      uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (order_id, university_id) REFERENCES orders (id, university_id),
  CHECK (cash_kobo <> 0 OR promo_kobo <> 0),
  CHECK (CASE kind
    WHEN 'TOPUP'             THEN cash_kobo > 0 AND promo_kobo = 0 AND topup_id IS NOT NULL
    WHEN 'ORDER_PAYMENT'     THEN cash_kobo <= 0 AND promo_kobo <= 0 AND order_id IS NOT NULL
    WHEN 'ORDER_RETURN'      THEN cash_kobo >= 0 AND promo_kobo >= 0 AND order_id IS NOT NULL
    WHEN 'CARD_REFUND'       THEN cash_kobo > 0 AND promo_kobo = 0 AND refund_id IS NOT NULL AND order_id IS NOT NULL
    WHEN 'UNMATCHED_PAYMENT' THEN cash_kobo > 0 AND promo_kobo = 0 AND payment_id IS NOT NULL
    WHEN 'PROMO_GRANT'       THEN promo_kobo > 0 AND cash_kobo = 0 AND created_by IS NOT NULL AND note IS NOT NULL
    WHEN 'WELCOME_CREDIT'    THEN promo_kobo > 0 AND cash_kobo = 0
    WHEN 'PROMO_REVOKE'      THEN promo_kobo < 0 AND cash_kobo = 0 AND created_by IS NOT NULL AND note IS NOT NULL
  END)
);
CREATE INDEX wallet_entries_user_idx ON wallet_entries (user_id, id DESC);
CREATE INDEX wallet_entries_order_idx ON wallet_entries (order_id) WHERE order_id IS NOT NULL;
-- Each source of money can be credited once.
CREATE UNIQUE INDEX wallet_entries_one_topup ON wallet_entries (topup_id) WHERE kind = 'TOPUP';
CREATE UNIQUE INDEX wallet_entries_one_card_refund ON wallet_entries (refund_id) WHERE kind = 'CARD_REFUND';
CREATE UNIQUE INDEX wallet_entries_one_unmatched ON wallet_entries (payment_id) WHERE kind = 'UNMATCHED_PAYMENT';
CREATE UNIQUE INDEX wallet_entries_one_order_payment ON wallet_entries (order_id) WHERE kind = 'ORDER_PAYMENT';
CREATE UNIQUE INDEX wallet_entries_one_welcome ON wallet_entries (user_id) WHERE kind = 'WELCOME_CREDIT';

-- Validates a ledger entry against its source (order, top-up, refund, payment).
CREATE FUNCTION pf_wallet_entry_apply() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  w_uni uuid;
  o record;
  net_cash bigint;
  net_promo bigint;
  src_amount bigint;
  src_status text;
  src_user uuid;
  src_dest text;
BEGIN
  -- Lock the wallet: concurrent spends of the same balance serialise here.
  SELECT university_id INTO w_uni FROM wallets WHERE user_id = NEW.user_id FOR UPDATE;
  IF w_uni IS NULL THEN
    RAISE EXCEPTION 'pf: no wallet for user %', NEW.user_id USING ERRCODE = 'P0007';
  END IF;
  IF w_uni <> NEW.university_id THEN
    RAISE EXCEPTION 'pf: wallet entry university does not match the wallet' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.order_id IS NOT NULL THEN
    SELECT student_user_id, status, total_kobo INTO o FROM orders WHERE id = NEW.order_id;
    IF o.student_user_id <> NEW.user_id THEN
      RAISE EXCEPTION 'pf: order % does not belong to this wallet', NEW.order_id USING ERRCODE = 'P0001';
    END IF;
    SELECT COALESCE(sum(cash_kobo), 0), COALESCE(sum(promo_kobo), 0) INTO net_cash, net_promo
      FROM wallet_entries WHERE order_id = NEW.order_id AND kind IN ('ORDER_PAYMENT', 'ORDER_RETURN');
  END IF;

  IF NEW.kind = 'ORDER_PAYMENT' THEN
    IF o.status <> 'AWAITING_PAYMENT' THEN
      RAISE EXCEPTION 'pf: wallet can only pay an order awaiting payment' USING ERRCODE = 'P0008';
    END IF;
    IF -(NEW.cash_kobo + NEW.promo_kobo) > o.total_kobo THEN
      RAISE EXCEPTION 'pf: wallet payment exceeds order total' USING ERRCODE = 'P0008';
    END IF;
  ELSIF NEW.kind = 'ORDER_RETURN' THEN
    -- Never give back more than was taken, bucket by bucket (no promo-to-cash conversion).
    IF net_cash + NEW.cash_kobo > 0 OR net_promo + NEW.promo_kobo > 0 THEN
      RAISE EXCEPTION 'pf: wallet return exceeds what this order took from the wallet' USING ERRCODE = 'P0006';
    END IF;
  ELSIF NEW.kind = 'TOPUP' THEN
    SELECT confirmed_amount_kobo, status, user_id INTO src_amount, src_status, src_user FROM wallet_topups WHERE id = NEW.topup_id;
    IF src_status <> 'SUCCEEDED' OR src_amount <> NEW.cash_kobo OR src_user <> NEW.user_id THEN
      RAISE EXCEPTION 'pf: top-up credit must match a succeeded top-up' USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.kind = 'CARD_REFUND' THEN
    SELECT r.amount_kobo, r.status, o2.student_user_id, r.destination INTO src_amount, src_status, src_user, src_dest
      FROM refunds r JOIN orders o2 ON o2.id = r.order_id WHERE r.id = NEW.refund_id AND r.order_id = NEW.order_id;
    IF src_status IS DISTINCT FROM 'SUCCEEDED' OR src_dest <> 'WALLET' OR src_amount <> NEW.cash_kobo OR src_user <> NEW.user_id THEN
      RAISE EXCEPTION 'pf: card refund credit must match a wallet refund' USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.kind = 'UNMATCHED_PAYMENT' THEN
    SELECT p.amount_kobo, p.status, o2.student_user_id INTO src_amount, src_status, src_user
      FROM payments p JOIN orders o2 ON o2.id = p.order_id WHERE p.id = NEW.payment_id;
    IF src_status NOT IN ('ABANDONED', 'FAILED') OR src_amount <> NEW.cash_kobo OR src_user <> NEW.user_id THEN
      RAISE EXCEPTION 'pf: unmatched payment credit must match an abandoned payment' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END $$;
-- Checks run before the insert; the balance moves only after the row is really
-- inserted, so an insert skipped by ON CONFLICT DO NOTHING never touches the balance.
CREATE TRIGGER wallet_entries_check BEFORE INSERT ON wallet_entries FOR EACH ROW EXECUTE FUNCTION pf_wallet_entry_apply();

CREATE FUNCTION pf_wallet_entry_post() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('pf.wallet_ledger', 'on', true);
  UPDATE wallets SET cash_kobo = cash_kobo + NEW.cash_kobo, promo_kobo = promo_kobo + NEW.promo_kobo, updated_at = now()
   WHERE user_id = NEW.user_id;
  PERFORM set_config('pf.wallet_ledger', 'off', true);
  RETURN NULL;
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'pf: insufficient wallet balance or wallet limit reached' USING ERRCODE = 'P0009';
END $$;
CREATE TRIGGER wallet_entries_post AFTER INSERT ON wallet_entries FOR EACH ROW EXECUTE FUNCTION pf_wallet_entry_post();
CREATE TRIGGER wallet_entries_no_update BEFORE UPDATE OR DELETE ON wallet_entries FOR EACH ROW EXECUTE FUNCTION pf_reject_mutation();

-- ---------------------------------------------------------------- payments with a wallet part
-- A card/transfer/USSD payment covers what the wallet does not.
CREATE OR REPLACE FUNCTION pf_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_total bigint; from_wallet bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT total_kobo INTO order_total FROM orders WHERE id = NEW.order_id;
    SELECT -COALESCE(sum(cash_kobo + promo_kobo), 0) INTO from_wallet
      FROM wallet_entries WHERE order_id = NEW.order_id AND kind IN ('ORDER_PAYMENT', 'ORDER_RETURN');
    IF NEW.amount_kobo <> order_total - from_wallet THEN
      RAISE EXCEPTION 'pf: payment amount % does not equal the amount due %', NEW.amount_kobo, order_total - from_wallet USING ERRCODE = 'P0005';
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

-- ---------------------------------------------------------------- paid means paid
-- An order becomes PAID only when the money for its whole total is in: a succeeded
-- provider payment plus whatever the wallet covered.
CREATE FUNCTION pf_order_paid_in_full() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE from_card bigint; from_wallet bigint;
BEGIN
  IF NEW.status = 'PAID' AND OLD.status = 'AWAITING_PAYMENT' THEN
    SELECT COALESCE(sum(amount_kobo), 0) INTO from_card FROM payments WHERE order_id = NEW.id AND status = 'SUCCEEDED';
    SELECT -COALESCE(sum(cash_kobo + promo_kobo), 0) INTO from_wallet
      FROM wallet_entries WHERE order_id = NEW.id AND kind IN ('ORDER_PAYMENT', 'ORDER_RETURN');
    IF from_card + from_wallet <> NEW.total_kobo THEN
      RAISE EXCEPTION 'pf: order % is not paid in full (% of %)', NEW.id, from_card + from_wallet, NEW.total_kobo USING ERRCODE = 'P0005';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_paid_in_full BEFORE UPDATE OF status ON orders FOR EACH ROW EXECUTE FUNCTION pf_order_paid_in_full();

-- Every student has a wallet: existing ones now, new ones when their profile is created.
INSERT INTO wallets (user_id, university_id) SELECT user_id, university_id FROM student_profiles ON CONFLICT DO NOTHING;

CREATE FUNCTION pf_student_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO wallets (user_id, university_id) VALUES (NEW.user_id, NEW.university_id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER student_profiles_wallet AFTER INSERT ON student_profiles FOR EACH ROW EXECUTE FUNCTION pf_student_wallet();
