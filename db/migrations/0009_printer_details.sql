-- PrintFlow 0009: what a provider can tell us about each printer.
--
-- A student with a printer in their hostel registers it here, the same way a shop
-- registers theirs: the devices table already existed for shop printers, so this
-- extends it rather than growing a second idea of what a printer is.
--
-- Every column added here is NULLABLE on purpose, and nothing in the ordering path
-- consults them. A provider who knows only "it's the HP in my room" can register it
-- and start printing today; the product tells them what each missing detail costs
-- them and their students, and then gets out of the way. Information we would like
-- is not the same as information we require, and a half-filled form has never
-- printed anyone's lecture notes.
--
-- NULL and "not told us" are the same state throughout. For the booleans that is
-- what NULL means; for paper_sizes an empty array is normalised to NULL by the
-- trigger below, so there is exactly one way to say "unknown".

ALTER TABLE devices
  ADD COLUMN serial_number text CHECK (serial_number IS NULL OR length(btrim(serial_number)) BETWEEN 2 AND 60),
  ADD COLUMN make          text CHECK (make IS NULL OR length(btrim(make)) BETWEEN 1 AND 60),
  ADD COLUMN model         text CHECK (model IS NULL OR length(btrim(model)) BETWEEN 1 AND 60),
  -- NULL means "not told us", which is different from false ("told us it cannot").
  ADD COLUMN colour        boolean,
  ADD COLUMN duplex        boolean,
  ADD COLUMN paper_sizes   text[] CHECK (paper_sizes IS NULL OR paper_sizes <@ ARRAY['A4', 'A3', 'A5', 'LETTER', 'LEGAL']::text[]),
  ADD COLUMN notes         text CHECK (notes IS NULL OR length(notes) <= 500),
  ADD COLUMN details_updated_at timestamptz;

-- A serial number identifies one physical machine, so the same one cannot be
-- registered twice inside a university. This is the check that stops a student
-- claiming a printer that is already somebody else's, and it is deliberately the
-- only thing about a printer that can be refused.
CREATE UNIQUE INDEX devices_serial_per_university
  ON devices (university_id, lower(btrim(serial_number)))
  WHERE serial_number IS NOT NULL;

CREATE INDEX devices_shop_idx ON devices (shop_id);

/**
 * Normalises what a provider typed: blank strings and empty arrays become NULL, so
 * "unknown" has one representation, and stamps when the details last changed.
 */
CREATE FUNCTION pf_device_details_normalise() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.serial_number := nullif(btrim(coalesce(NEW.serial_number, '')), '');
  NEW.make          := nullif(btrim(coalesce(NEW.make, '')), '');
  NEW.model         := nullif(btrim(coalesce(NEW.model, '')), '');
  NEW.notes         := nullif(btrim(coalesce(NEW.notes, '')), '');
  IF NEW.paper_sizes IS NOT NULL AND cardinality(NEW.paper_sizes) = 0 THEN
    NEW.paper_sizes := NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.serial_number IS NOT NULL OR NEW.make IS NOT NULL OR NEW.model IS NOT NULL
       OR NEW.colour IS NOT NULL OR NEW.duplex IS NOT NULL OR NEW.paper_sizes IS NOT NULL THEN
      NEW.details_updated_at := now();
    END IF;
  ELSIF (NEW.serial_number, NEW.make, NEW.model, NEW.colour, NEW.duplex, NEW.paper_sizes, NEW.notes)
        IS DISTINCT FROM (OLD.serial_number, OLD.make, OLD.model, OLD.colour, OLD.duplex, OLD.paper_sizes, OLD.notes) THEN
    NEW.details_updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER devices_details_normalise
  BEFORE INSERT OR UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION pf_device_details_normalise();
