-- Run this once in your Supabase SQL editor to add the moved column.
-- Moved cafes keep their manually adjusted lat/lng during OSM syncs.

ALTER TABLE cafes ADD COLUMN IF NOT EXISTS moved boolean DEFAULT false NOT NULL;

-- Index so the sync query that skips moved rows is fast
CREATE INDEX IF NOT EXISTS cafes_moved_idx ON cafes (moved) WHERE moved = true;
