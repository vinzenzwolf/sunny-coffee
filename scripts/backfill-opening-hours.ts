/**
 * Backfill opening_hours (jsonb) on the cafes table from Google Places API.
 *
 * Usage:
 *   npx tsx scripts/backfill-opening-hours.ts
 *   npx tsx scripts/backfill-opening-hours.ts --dry-run
 *   npx tsx scripts/backfill-opening-hours.ts --force      # re-fetch even if already filled
 *
 * Required env vars:
 *   EXPO_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   EXPO_PUBLIC_GOOGLE_PLACES_API_KEY
 *
 * Optional env vars:
 *   PAGE_SIZE          (default: 200)
 *   REQUEST_DELAY_MS   (default: 150)
 *   MAX_UPDATES        (default: unlimited)
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DayKey = 'su' | 'mo' | 'tu' | 'we' | 'th' | 'fr' | 'sa';
type DayHours = { open: string; close: string };
type OpeningHoursJson = Partial<Record<DayKey, DayHours>>;

type GooglePeriodPoint = { day: number; hour: number; minute: number };
type GooglePeriod = { open: GooglePeriodPoint; close?: GooglePeriodPoint };

type GoogleOpeningHours = {
  periods?: GooglePeriod[];
  weekdayDescriptions?: string[];
};

type GooglePlaceResponse = {
  regularOpeningHours?: GoogleOpeningHours;
};

type CafeRow = {
  id: string;
  name: string | null;
  opening_hours: unknown;
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const argv = new Set(process.argv.slice(2));
const DRY_RUN = argv.has('--dry-run');
const FORCE = argv.has('--force');

function loadEnvFromRoot(): void {
  const envPath = path.resolve(__dirname, '../.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadEnvFromRoot();

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY ??
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const GOOGLE_API_KEY =
  process.env.EXPO_PUBLIC_GOOGLE_PLACES_API_KEY ?? process.env.GOOGLE_PLACES_API_KEY;

const PAGE_SIZE = Number(process.env.PAGE_SIZE ?? 200);
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS ?? 150);
const MAX_UPDATES = process.env.MAX_UPDATES ? Number(process.env.MAX_UPDATES) : Infinity;

if (!SUPABASE_URL || !SUPABASE_KEY || !GOOGLE_API_KEY) {
  console.error('Missing env vars. Need EXPO_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EXPO_PUBLIC_GOOGLE_PLACES_API_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------------------------------------------------------------------------
// Conversion logic
// ---------------------------------------------------------------------------

const DAY_KEYS: DayKey[] = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];

function hhMM(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function convertPeriods(periods: GooglePeriod[]): OpeningHoursJson | null {
  if (periods.length === 0) return null;

  // 24/7: single period, open at 00:00 day=0, no close field
  if (
    periods.length === 1 &&
    !periods[0].close &&
    periods[0].open.day === 0 &&
    periods[0].open.hour === 0 &&
    periods[0].open.minute === 0
  ) {
    const result: OpeningHoursJson = {};
    for (const key of DAY_KEYS) result[key] = { open: '00:00', close: '24:00' };
    return result;
  }

  // Start with all days marked closed
  const result: OpeningHoursJson = {};
  for (const key of DAY_KEYS) result[key] = { open: '00:00', close: '00:00' };

  // Overwrite with actual open periods
  for (const period of periods) {
    const dayKey = DAY_KEYS[period.open.day];
    if (!dayKey) continue;

    const openStr = hhMM(period.open.hour, period.open.minute);
    let closeStr: string;

    if (!period.close) {
      closeStr = '24:00';
    } else if (period.close.day !== period.open.day) {
      // Overnight (e.g. Fri 14:00 → Sat 00:00) — treat as end of open day
      closeStr = '24:00';
    } else {
      closeStr = hhMM(period.close.hour, period.close.minute);
    }

    result[dayKey] = { open: openStr, close: closeStr };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Google Places fetch
// ---------------------------------------------------------------------------

async function fetchOpeningHours(placeId: string): Promise<OpeningHoursJson | null> {
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;
  const res = await fetch(url, {
    headers: {
      'X-Goog-Api-Key': GOOGLE_API_KEY!,
      'X-Goog-FieldMask': 'regularOpeningHours',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google Places ${res.status} for ${placeId}: ${body}`);
  }

  const data = (await res.json()) as GooglePlaceResponse;
  const periods = data.regularOpeningHours?.periods;

  if (!periods) return null;
  return convertPeriods(periods);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}${FORCE ? ' + FORCE' : ''}`);

  let offset = 0;
  let scanned = 0;
  let skipped = 0;
  let updated = 0;
  let missing = 0;
  let failed = 0;

  while (updated < MAX_UPDATES) {
    const { data, error } = await supabase
      .from('cafes')
      .select('id, name, opening_hours')
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw new Error(`Failed to read cafes: ${error.message}`);
    const rows = (data ?? []) as CafeRow[];
    if (rows.length === 0) break;

    console.log(`\nProcessing rows ${offset + 1}–${offset + rows.length}...`);

    for (const row of rows) {
      if (updated >= MAX_UPDATES) break;
      scanned += 1;

      if (!FORCE && row.opening_hours !== null && row.opening_hours !== undefined) {
        skipped += 1;
        continue;
      }

      try {
        const hours = await fetchOpeningHours(row.id);

        if (!hours) {
          missing += 1;
          console.log(`  [no data] ${row.id} (${row.name ?? '?'})`);
        } else {
          const days = Object.entries(hours)
            .map(([d, v]) => `${d}:${(v as DayHours).open}–${(v as DayHours).close}`)
            .join(' ');
          console.log(`  [ok] ${row.name ?? row.id}  ${days}`);
        }

        if (!DRY_RUN) {
          const { error: updateError } = await supabase
            .from('cafes')
            .update({ opening_hours: hours })
            .eq('id', row.id);
          if (updateError) throw new Error(updateError.message);
        }

        updated += 1;
      } catch (err) {
        failed += 1;
        console.error(`  [error] ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      }

      await sleep(REQUEST_DELAY_MS);
    }

    offset += PAGE_SIZE;
  }

  console.log('');
  console.log(`Done. scanned=${scanned}  updated=${updated}  skipped=${skipped}  missing=${missing}  failed=${failed}`);
  if (DRY_RUN) console.log('Dry run — no rows written.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
