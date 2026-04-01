-- Adds a Google formatted address column for cafe rows.
ALTER TABLE IF EXISTS public.caffees
ADD COLUMN IF NOT EXISTS google_formatted_address text;

-- Backward compatibility with existing table name in this repo.
ALTER TABLE IF EXISTS public.cafes
ADD COLUMN IF NOT EXISTS google_formatted_address text;
