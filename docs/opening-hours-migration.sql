-- Step 1: Add the new jsonb column to cafes
-- (drop the old text column if it exists)
ALTER TABLE public.cafes DROP COLUMN IF EXISTS opening_hours;
ALTER TABLE public.cafes ADD COLUMN opening_hours jsonb;

-- Step 2: Migrate existing cafe_hours rows into the new column
-- Converts e.g. { day: 'monday', open: '09:00', close: '18:00' }
--           → cafes.opening_hours = { "mo": { "open": "09:00", "close": "18:00" } }
UPDATE public.cafes c
SET opening_hours = (
  SELECT jsonb_object_agg(
    CASE LOWER(h.day)
      WHEN 'monday'    THEN 'mo'
      WHEN 'tuesday'   THEN 'tu'
      WHEN 'wednesday' THEN 'we'
      WHEN 'thursday'  THEN 'th'
      WHEN 'friday'    THEN 'fr'
      WHEN 'saturday'  THEN 'sa'
      WHEN 'sunday'    THEN 'su'
      ELSE LOWER(LEFT(h.day, 2))
    END,
    jsonb_build_object('open', h.open, 'close', h.close)
  )
  FROM public.cafe_hours h
  WHERE h.cafe_id = c.id
)
WHERE EXISTS (SELECT 1 FROM public.cafe_hours h WHERE h.cafe_id = c.id);

-- Step 3: Drop the old table once you've verified the migration looks correct
-- DROP TABLE public.cafe_hours;
