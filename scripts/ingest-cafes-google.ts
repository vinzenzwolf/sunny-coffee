/**
 * One-time ingestion: fetch cafes from Google Places API and store in Supabase.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... GOOGLE_PLACES_API_KEY=... \
 *     npx tsx scripts/ingest-cafes-google.ts
 *
 * Required env vars:
 *   EXPO_PUBLIC_SUPABASE_URL       — Supabase project URL
 *   EXPO_PUBLIC_SUPABASE_ANON_KEY  — Supabase anon key
 *   EXPO_PUBLIC_GOOGLE_PLACES_API_KEY — Google Places API key
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

// Load .env from repo root
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] ??= match[2].trim();
  }
}

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const GOOGLE_API_KEY = process.env.EXPO_PUBLIC_GOOGLE_PLACES_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !GOOGLE_API_KEY) {
  console.error('Missing required env vars: EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY, EXPO_PUBLIC_GOOGLE_PLACES_API_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Dense grid covering greater Copenhagen.
// Step ~1 100 m so a radius of 900 m gives overlapping cells with no gaps,
// and each cell is small enough to stay well under the 20-result cap.
const SEARCH_RADIUS_M = 450;
const LAT_STEP = 0.004; // ≈ 445 m
const LNG_STEP = 0.008; // ≈ 504 m at 55.67 °N
const BBOX = { south: 55.595, north: 55.745, west: 12.44, east: 12.74 };

const SEARCH_CENTERS: { lat: number; lng: number }[] = [];
for (let lat = BBOX.south; lat <= BBOX.north + 0.001; lat += LAT_STEP) {
  for (let lng = BBOX.west; lng <= BBOX.east + 0.001; lng += LNG_STEP) {
    SEARCH_CENTERS.push({
      lat: Math.round(lat * 10000) / 10000,
      lng: Math.round(lng * 10000) / 10000,
    });
  }
}
console.log(`Grid: ${SEARCH_CENTERS.length} cells (radius ${SEARCH_RADIUS_M} m)`);

type OpeningHoursPeriod = {
  open: { day: number; hour: number; minute: number };
  close: { day: number; hour: number; minute: number };
};

type GooglePlace = {
  id: string;
  displayName: { text: string };
  location: { latitude: number; longitude: number };
  regularOpeningHours?: { periods?: OpeningHoursPeriod[] };
};

async function searchNearby(lat: number, lng: number, radius: number): Promise<GooglePlace[]> {
  const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_API_KEY!,
      'X-Goog-FieldMask':
        'places.id,places.displayName,places.location,places.regularOpeningHours.periods',
    },
    body: JSON.stringify({
      includedTypes: ['cafe', 'coffee_shop','coffee_stand', 'coffee_roastery', 'cat_cafe', 'dog_cafe', 'brunch_restaurant'],
      maxResultCount: 20,
      locationRestriction: {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius,
        },
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Places API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { places?: GooglePlace[] };
  return data.places ?? [];
}

// If a cell hits the 20-result cap, split into 4 quadrants and search each.
// Recurses up to 3 levels deep (radius down to ~56 m) before giving up.
async function searchCell(lat: number, lng: number, radius = SEARCH_RADIUS_M, depth = 0): Promise<GooglePlace[]> {
  const places = await searchNearby(lat, lng, radius);
  await new Promise((r) => setTimeout(r, 200));

  if (places.length < 20 || depth >= 3) return places;

  // Hit the cap — subdivide into 4 quadrants
  const indent = '  '.repeat(depth + 2);
  console.log(`${indent}⚠️  Cap hit at (${lat}, ${lng}) r=${radius}m — subdividing into 4...`);

  const half = radius / 2;
  const dLat = half / 111320;
  const dLng = half / (111320 * Math.cos((lat * Math.PI) / 180));

  const quadrants = [
    { lat: lat - dLat, lng: lng - dLng },
    { lat: lat - dLat, lng: lng + dLng },
    { lat: lat + dLat, lng: lng - dLng },
    { lat: lat + dLat, lng: lng + dLng },
  ];

  const results: GooglePlace[] = [];
  for (const q of quadrants) {
    const sub = await searchCell(
      Math.round(q.lat * 100000) / 100000,
      Math.round(q.lng * 100000) / 100000,
      half,
      depth + 1,
    );
    results.push(...sub);
  }
  return results;
}

// ── JSON cache ─────────────────────────────────────────────────────────────
const CACHE_FILE = path.resolve(__dirname, 'cache-google.json');

// ── Main ───────────────────────────────────────────────────────────────────
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function toHHMM(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

async function main() {
  // ── Phase 1: load from cache or fetch from Google ──────────────────────
  let places: GooglePlace[];

  if (fs.existsSync(CACHE_FILE)) {
    console.log(`Cache found — loading from ${CACHE_FILE} instead of fetching Google...\n`);
    places = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as GooglePlace[];
    console.log(`  Loaded ${places.length} places from cache.`);
  } else {
    console.log('Fetching cafes from Google Places...');
    const seen = new Map<string, GooglePlace>();

    for (const center of SEARCH_CENTERS) {
      console.log(`  Searching near (${center.lat}, ${center.lng})...`);
      const results = await searchCell(center.lat, center.lng);
      let newCount = 0;
      for (const p of results) {
        if (!seen.has(p.id)) { seen.set(p.id, p); newCount++; }
      }
      const cappedWarning = results.length === 60 ? ' ⚠️  HIT CAP (60) — consider smaller grid here' : '';
      console.log(`  → ${results.length} results, ${newCount} new (total unique: ${seen.size})${cappedWarning}`);
      await new Promise((r) => setTimeout(r, 200));
    }

    places = Array.from(seen.values());
    fs.writeFileSync(CACHE_FILE, JSON.stringify(places, null, 2), 'utf8');
    console.log(`\nFound ${places.length} unique cafes — saved to ${CACHE_FILE}`);
  }

  // ── Transform ──────────────────────────────────────────────────────────
  const cafeRows = places.map((p) => ({
    id: p.id,
    name: p.displayName.text,
    lat: p.location.latitude,
    lng: p.location.longitude,
  }));

  // Deduplicate: keep first period per (cafe_id, day)
  const hoursSeen = new Set<string>();
  const hoursRows = places.flatMap((p) =>
    (p.regularOpeningHours?.periods ?? [])
      .filter((period) => period.open)
      .map((period) => ({
        cafe_id: p.id,
        day: DAY_NAMES[period.open.day],
        open:  period.close ? toHHMM(period.open.hour,  period.open.minute)  : '00:00',
        close: period.close ? toHHMM(period.close.hour, period.close.minute) : '24:00',
      }))
      .filter((row) => {
        const key = `${row.cafe_id}:${row.day}`;
        if (hoursSeen.has(key)) return false;
        hoursSeen.add(key);
        return true;
      }),
  );

  // ── Phase 2: insert into Supabase ─────────────────────────────────────
  console.log('\nDeleting existing cafes from Supabase...');
  const { error: deleteError } = await supabase.from('cafes').delete().neq('id', '');
  if (deleteError) throw new Error(`Delete failed: ${deleteError.message}`);
  console.log('Deleted.');

  console.log(`Inserting ${cafeRows.length} cafes...`);
  for (let i = 0; i < cafeRows.length; i += 100) {
    const batch = cafeRows.slice(i, i + 100);
    const { error } = await supabase.from('cafes').insert(batch);
    if (error) throw new Error(`Insert cafes batch ${i / 100 + 1} failed: ${error.message}`);
    console.log(`  Inserted ${Math.min(i + 100, cafeRows.length)}/${cafeRows.length}`);
  }

  console.log(`Inserting ${hoursRows.length} opening hours rows...`);
  for (let i = 0; i < hoursRows.length; i += 500) {
    const batch = hoursRows.slice(i, i + 500);
    const { error } = await supabase.from('cafe_hours').insert(batch);
    if (error) throw new Error(`Insert hours batch ${i / 500 + 1} failed: ${error.message}`);
    console.log(`  Inserted ${Math.min(i + 500, hoursRows.length)}/${hoursRows.length}`);
  }

  console.log('\nDone!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
