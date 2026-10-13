-- PrintFlow 0002: services catalogue, versioned rate cards, bounds, overrides.
-- A published rate card is immutable. Price changes publish a new version.

CREATE TABLE rate_cards (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id    uuid NOT NULL REFERENCES universities (id),
  -- NULL: campus-wide card (university-controlled). Set: a shop's own card (merchant-controlled).
  shop_id          uuid,
  version          integer NOT NULL CHECK (version >= 1),
  status           text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
  odd_page_duplex_policy text NOT NULL DEFAULT 'CHARGE_FULL_SHEET'
                   CHECK (odd_page_duplex_policy IN ('CHARGE_FULL_SHEET', 'CHARGE_AS_SINGLE_SIDED')),
  minimum_charge_kobo bigint NOT NULL DEFAULT 0 CHECK (minimum_charge_kobo >= 0),
  effective_from   timestamptz NOT NULL,
  effective_to     timestamptz,
  published_at     timestamptz,
  published_by     uuid REFERENCES users (id),
  created_by       uuid NOT NULL REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, university_id) REFERENCES shops (id, university_id),
  UNIQUE (id, university_id),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (status = 'DRAFT' OR (published_at IS NOT NULL AND published_by IS NOT NULL))
);
-- Version numbers are unique per scope (campus card, or each shop's card).
CREATE UNIQUE INDEX rate_card_campus_version_uq ON rate_cards (university_id, version) WHERE shop_id IS NULL;
CREATE UNIQUE INDEX rate_card_shop_version_uq ON rate_cards (shop_id, version) WHERE shop_id IS NOT NULL;
CREATE INDEX rate_card_lookup_idx ON rate_cards (university_id, shop_id, status, effective_from DESC);

CREATE TABLE rate_card_sheet_prices (
  rate_card_id    uuid NOT NULL REFERENCES rate_cards (id) ON DELETE CASCADE,
  paper_size      text NOT NULL CHECK (paper_size IN ('A4', 'A3', 'A5', 'LETTER', 'LEGAL')),
  colour_mode     text NOT NULL CHECK (colour_mode IN ('BW', 'COLOUR')),
  sides           text NOT NULL CHECK (sides IN ('SINGLE', 'DOUBLE')),
  price_per_sheet_kobo bigint NOT NULL CHECK (price_per_sheet_kobo > 0),
  PRIMARY KEY (rate_card_id, paper_size, colour_mode, sides)
);

CREATE TABLE rate_card_finishing (
  rate_card_id  uuid NOT NULL REFERENCES rate_cards (id) ON DELETE CASCADE,
  code          text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  unit          text NOT NULL CHECK (unit IN ('PER_ORDER', 'PER_COPY', 'PER_SHEET')),
  price_kobo    bigint NOT NULL CHECK (price_kobo >= 0),
  paper_sizes   text[] CHECK (paper_sizes <@ ARRAY['A4', 'A3', 'A5', 'LETTER', 'LEGAL']::text[]),
  PRIMARY KEY (rate_card_id, code)
);

-- Published cards and their lines cannot change.
CREATE FUNCTION pf_rate_card_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'pf: published rate card % cannot be deleted', OLD.id USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'DRAFT' THEN
    -- After publishing, the only permitted changes are retiring the card and
    -- closing its effective window. Prices and terms can never be edited.
    IF ROW(NEW.id, NEW.university_id, NEW.shop_id, NEW.version, NEW.odd_page_duplex_policy,
           NEW.minimum_charge_kobo, NEW.effective_from, NEW.published_at, NEW.published_by, NEW.created_by)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.university_id, OLD.shop_id, OLD.version, OLD.odd_page_duplex_policy,
           OLD.minimum_charge_kobo, OLD.effective_from, OLD.published_at, OLD.published_by, OLD.created_by)
       OR NEW.status = 'DRAFT'
       OR (OLD.status = 'RETIRED' AND NEW.status <> 'RETIRED')
       OR (OLD.effective_to IS NOT NULL AND NEW.effective_to IS DISTINCT FROM OLD.effective_to) THEN
      RAISE EXCEPTION 'pf: published rate card % is immutable; publish a new version', OLD.id USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rate_cards_guard BEFORE UPDATE OR DELETE ON rate_cards
  FOR EACH ROW EXECUTE FUNCTION pf_rate_card_guard();

CREATE FUNCTION pf_rate_card_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  card_id uuid := COALESCE(NEW.rate_card_id, OLD.rate_card_id);
  card_status text;
BEGIN
  SELECT status INTO card_status FROM rate_cards WHERE id = card_id;
  IF card_status IS NOT NULL AND card_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'pf: lines of published rate card % are immutable', card_id USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER sheet_prices_guard BEFORE INSERT OR UPDATE OR DELETE ON rate_card_sheet_prices
  FOR EACH ROW EXECUTE FUNCTION pf_rate_card_line_guard();
CREATE TRIGGER finishing_guard BEFORE INSERT OR UPDATE OR DELETE ON rate_card_finishing
  FOR EACH ROW EXECUTE FUNCTION pf_rate_card_line_guard();

-- Agreement bounds for merchant-controlled pricing, set by the university.
CREATE TABLE price_bounds (
  university_id uuid NOT NULL REFERENCES universities (id),
  paper_size    text NOT NULL CHECK (paper_size IN ('A4', 'A3', 'A5', 'LETTER', 'LEGAL')),
  colour_mode   text NOT NULL CHECK (colour_mode IN ('BW', 'COLOUR')),
  sides         text NOT NULL CHECK (sides IN ('SINGLE', 'DOUBLE')),
  min_kobo      bigint NOT NULL CHECK (min_kobo > 0),
  max_kobo      bigint NOT NULL,
  updated_by    uuid NOT NULL REFERENCES users (id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (university_id, paper_size, colour_mode, sides),
  CHECK (max_kobo >= min_kobo)
);

-- University-approved overrides of individual campus-card lines for one shop.
CREATE TABLE shop_price_overrides (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id uuid NOT NULL,
  shop_id       uuid NOT NULL,
  rate_card_id  uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('SHEET', 'FINISHING')),
  paper_size    text,
  colour_mode   text,
  sides         text,
  finishing_code text,
  price_kobo    bigint NOT NULL CHECK (price_kobo >= 0),
  approved_by   uuid NOT NULL REFERENCES users (id),
  approved_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  FOREIGN KEY (shop_id, university_id) REFERENCES shops (id, university_id),
  FOREIGN KEY (rate_card_id, university_id) REFERENCES rate_cards (id, university_id),
  CHECK (
    (kind = 'SHEET' AND paper_size IS NOT NULL AND colour_mode IS NOT NULL AND sides IS NOT NULL AND finishing_code IS NULL)
    OR (kind = 'FINISHING' AND finishing_code IS NOT NULL AND paper_size IS NULL AND colour_mode IS NULL AND sides IS NULL)
  )
);
CREATE UNIQUE INDEX shop_override_sheet_uq ON shop_price_overrides (shop_id, rate_card_id, paper_size, colour_mode, sides)
  WHERE kind = 'SHEET' AND revoked_at IS NULL;
CREATE UNIQUE INDEX shop_override_finishing_uq ON shop_price_overrides (shop_id, rate_card_id, finishing_code)
  WHERE kind = 'FINISHING' AND revoked_at IS NULL;
