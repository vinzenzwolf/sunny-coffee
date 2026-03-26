-- Building footprints from OpenStreetMap, synced weekly
create table if not exists public.buildings (
  id         text primary key,       -- "way/123456"
  coords     jsonb not null,         -- [[lon, lat], ...]
  height_m   double precision not null,
  synced_at  timestamptz default now()
);

alter table public.buildings enable row level security;

-- Public read
create policy "buildings_public_read" on public.buildings for select using (true);

-- Only service role can write
create policy "buildings_service_write" on public.buildings for all using (auth.role() = 'service_role');

-- Spatial index on coords is not straightforward with jsonb;
-- a simple index on id is enough since we load all buildings at once
create index if not exists idx_buildings_synced_at on public.buildings(synced_at);
