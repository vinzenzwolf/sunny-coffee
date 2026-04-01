-- Adds a Google formatted address column for cafe rows.
ALTER TABLE IF EXISTS public.cafes
ADD COLUMN IF NOT EXISTS google_formatted_address text;
