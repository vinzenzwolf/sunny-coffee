-- Cafes: sourced from OpenStreetMap via Overpass
create table if not exists public.cafes (
  id            text primary key,          -- "node/123456" OSM id
  name          text not null,
  lat           double precision not null,
  lng           double precision not null,
  area          text,
  opening_hours text,
  cuisine       text,
  website       text,
  osm_updated_at timestamptz default now(),
  created_at    timestamptz default now()
);

-- Sun windows: 5-minute resolution, stored as contiguous intervals per day
create table if not exists public.sun_windows (
  cafe_id     text references public.cafes(id) on delete cascade,
  date        date not null,
  intervals   jsonb not null default '[]', -- [{start: "08:00", end: "14:30"}, ...]
  computed_at timestamptz default now(),
  primary key (cafe_id, date)
);

-- Saved cafes: user <-> cafe many-to-many (user is from Supabase auth)
create table if not exists public.saved_cafes (
  user_id   uuid references auth.users(id) on delete cascade,
  cafe_id   text references public.cafes(id) on delete cascade,
  saved_at  timestamptz default now(),
  primary key (user_id, cafe_id)
);

-- Row Level Security
alter table public.cafes enable row level security;
alter table public.sun_windows enable row level security;
alter table public.saved_cafes enable row level security;

-- Cafes and sun_windows are public read
create policy "cafes_public_read" on public.cafes for select using (true);
create policy "sun_windows_public_read" on public.sun_windows for select using (true);

-- Only service role can write cafes / sun_windows (backend scheduler)
create policy "cafes_service_write" on public.cafes for all using (auth.role() = 'service_role');
create policy "sun_windows_service_write" on public.sun_windows for all using (auth.role() = 'service_role');

-- Users can only see/modify their own saved cafes
create policy "saved_cafes_own" on public.saved_cafes for all using (auth.uid() = user_id);

-- Indexes
create index if not exists idx_sun_windows_date on public.sun_windows(date);
create index if not exists idx_saved_cafes_user on public.saved_cafes(user_id);
