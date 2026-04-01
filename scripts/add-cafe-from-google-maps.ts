/**
 * Add or update one cafe from a Google Place ID.
 *
 * Usage:
 *   npx tsx scripts/add-cafe-from-google-maps.ts "<PLACE_ID>"
 *   npx tsx scripts/add-cafe-from-google-maps.ts "places/<PLACE_ID>"
 *
 * Required env vars:
 *   EXPO_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY (recommended) or EXPO_PUBLIC_SUPABASE_ANON_KEY
 *   EXPO_PUBLIC_GOOGLE_PLACES_API_KEY (or GOOGLE_PLACES_API_KEY)
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

type OpeningHoursPeriod = {
  open?: { day: number; hour: number; minute: number };
  close?: { day: number; hour: number; minute: number };
};

type GooglePlace = {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  regularOpeningHours?: { periods?: OpeningHoursPeriod[] };
};

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function loadEnvFromRoot(): void {
  const envPath = path.resolve(__dirname, '../.env');
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

function normalizePlaceId(input: string): string {
  return input.trim().replace(/^places\//, '');
}

function toHHMM(hour = 0, minute = 0): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

async function fetchPlaceById(apiKey: string, placeId: string): Promise<GooglePlace> {
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask':
        'id,displayName,location,formattedAddress,regularOpeningHours.periods',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google Places details failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as GooglePlace;
  if (!data?.id || !data?.location) {
    throw new Error('Google Places response missing required id/location.');
  }
  return data;
}

async function cafeHoursTableExists(supabase: ReturnType<typeof createClient>): Promise<boolean> {
  const { error } = await supabase.from('cafe_hours').select('cafe_id', { head: true, count: 'exact' }).limit(1);
  if (!error) return true;
  const msg = error.message.toLowerCase();
  if (msg.includes('does not exist') || msg.includes('could not find')) return false;
  throw new Error(`Could not verify cafe_hours table: ${error.message}`);
}

function buildCafeHoursRows(place: GooglePlace): { cafe_id: string; day: string; open: string; close: string }[] {
  const periods = place.regularOpeningHours?.periods ?? [];
  const seen = new Set<string>();

  return periods
    .filter((p) => p.open && typeof p.open.day === 'number')
    .map((p) => ({
      cafe_id: place.id,
      day: DAY_NAMES[p.open!.day] ?? 'monday',
      open: toHHMM(p.open?.hour ?? 0, p.open?.minute ?? 0),
      close: p.close ? toHHMM(p.close.hour ?? 0, p.close.minute ?? 0) : '24:00',
    }))
    .filter((row) => {
      const key = `${row.cafe_id}:${row.day}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function main(): Promise<void> {
  loadEnvFromRoot();

  const placeIdRaw = process.argv[2];
  if (!placeIdRaw) {
    console.error('Usage: npx tsx scripts/add-cafe-from-google-maps.ts "<PLACE_ID>"');
    process.exit(1);
  }
  const placeId = normalizePlaceId(placeIdRaw);

  const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const SUPABASE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY ??
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  const GOOGLE_API_KEY =
    process.env.EXPO_PUBLIC_GOOGLE_PLACES_API_KEY ?? process.env.GOOGLE_PLACES_API_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY || !GOOGLE_API_KEY) {
    console.error(
      'Missing env vars. Need EXPO_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EXPO_PUBLIC_GOOGLE_PLACES_API_KEY',
    );
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const place = await fetchPlaceById(GOOGLE_API_KEY, placeId);

  const row = {
    id: place.id,
    name: place.displayName?.text?.trim() || 'Cafe',
    lat: place.location!.latitude,
    lng: place.location!.longitude,
    google_formatted_address: place.formattedAddress ?? null,
  };

  const { error: upsertError } = await supabase.from('cafes').upsert(row, { onConflict: 'id' });
  if (upsertError) throw new Error(`Failed upserting public.cafes row: ${upsertError.message}`);

  console.log(`Upserted cafe: ${row.name}`);
  console.log(`  id: ${row.id}`);
  console.log(`  lat/lng: ${row.lat}, ${row.lng}`);
  console.log(`  formattedAddress: ${row.google_formatted_address ?? '(none)'}`);

  const hasCafeHours = await cafeHoursTableExists(supabase);
  if (!hasCafeHours) {
    console.log('Skipped cafe_hours sync (table does not exist).');
    return;
  }

  const hoursRows = buildCafeHoursRows(place);
  const { error: deleteHoursError } = await supabase.from('cafe_hours').delete().eq('cafe_id', row.id);
  if (deleteHoursError) throw new Error(`Failed clearing cafe_hours for ${row.id}: ${deleteHoursError.message}`);

  if (hoursRows.length) {
    const { error: insertHoursError } = await supabase.from('cafe_hours').insert(hoursRows);
    if (insertHoursError) throw new Error(`Failed inserting cafe_hours for ${row.id}: ${insertHoursError.message}`);
  }

  console.log(`Synced cafe_hours rows: ${hoursRows.length}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

