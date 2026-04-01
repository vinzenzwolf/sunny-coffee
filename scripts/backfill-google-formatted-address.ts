/**
 * Backfill Google Places formattedAddress into a new DB column.
 *
 * Usage:
 *   npx tsx scripts/backfill-google-formatted-address.ts
 *   npx tsx scripts/backfill-google-formatted-address.ts --dry-run
 *   npx tsx scripts/backfill-google-formatted-address.ts --force
 *
 * Required env vars:
 *   EXPO_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY (recommended)
 *   EXPO_PUBLIC_GOOGLE_PLACES_API_KEY
 *
 * Optional env vars:
 *   CAFE_TABLE            (overrides auto-detection)
 *   PAGE_SIZE             (default: 200)
 *   REQUEST_DELAY_MS      (default: 150)
 *   MAX_UPDATES           (default: unlimited)
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

type CafeRow = {
  id: string;
  name: string | null;
  google_formatted_address: string | null;
};

const argv = new Set(process.argv.slice(2));
const DRY_RUN = argv.has('--dry-run');
const FORCE = argv.has('--force');

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
  console.error(
    'Missing env vars. Need EXPO_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EXPO_PUBLIC_GOOGLE_PLACES_API_KEY',
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMissingTableError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('relation') && lower.includes('does not exist')
  ) || lower.includes('could not find the table');
}

async function detectTableName(): Promise<string> {
  const preferred = process.env.CAFE_TABLE?.trim();
  const candidates = [preferred, 'caffees', 'cafes'].filter(
    (name, idx, arr): name is string => Boolean(name) && arr.indexOf(name) === idx,
  );

  for (const tableName of candidates) {
    const { error } = await supabase.from(tableName).select('id', { head: true, count: 'exact' }).limit(1);
    if (!error) return tableName;
    if (isMissingTableError(error.message)) continue;
    throw new Error(`Cannot access table "${tableName}": ${error.message}`);
  }

  throw new Error(
    `Could not find a cafes table. Tried: ${candidates.join(', ')}. Set CAFE_TABLE explicitly if needed.`,
  );
}

async function fetchFormattedAddress(placeId: string): Promise<string | null> {
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;
  const res = await fetch(url, {
    headers: {
      'X-Goog-Api-Key': GOOGLE_API_KEY,
      'X-Goog-FieldMask': 'formattedAddress',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google Places ${res.status} for ${placeId}: ${body}`);
  }

  const data = (await res.json()) as { formattedAddress?: string };
  return data.formattedAddress ?? null;
}

async function main(): Promise<void> {
  const tableName = await detectTableName();
  console.log(`Using table: public.${tableName}`);

  let offset = 0;
  let scanned = 0;
  let skipped = 0;
  let updated = 0;
  let missing = 0;
  let failed = 0;

  while (updated < MAX_UPDATES) {
    const upper = offset + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from(tableName)
      .select('id,name,google_formatted_address')
      .order('id', { ascending: true })
      .range(offset, upper);

    if (error) {
      if (error.message.toLowerCase().includes('google_formatted_address')) {
        throw new Error(
          `Column google_formatted_address missing on public.${tableName}. Run backend/migrations/003_add_google_formatted_address.sql first.`,
        );
      }
      throw new Error(`Failed to read cafes: ${error.message}`);
    }

    const rows = (data ?? []) as CafeRow[];
    if (rows.length === 0) break;

    console.log(`Processing rows ${offset + 1}-${offset + rows.length}...`);
    for (const row of rows) {
      if (updated >= MAX_UPDATES) break;

      scanned += 1;
      if (!row.id) {
        skipped += 1;
        continue;
      }
      if (!FORCE && row.google_formatted_address) {
        skipped += 1;
        continue;
      }

      try {
        const formattedAddress = await fetchFormattedAddress(row.id);

        if (!formattedAddress) {
          missing += 1;
          console.log(`  [missing] ${row.id} (${row.name ?? 'unknown'})`);
        } else {
          console.log(`  [ok] ${row.id} -> ${formattedAddress}`);
        }

        if (!DRY_RUN) {
          const { error: updateError } = await supabase
            .from(tableName)
            .update({ google_formatted_address: formattedAddress })
            .eq('id', row.id);
          if (updateError) throw new Error(updateError.message);
        }

        updated += 1;
      } catch (err) {
        failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  [error] ${row.id}: ${message}`);
      }

      await sleep(REQUEST_DELAY_MS);
    }

    offset += PAGE_SIZE;
  }

  console.log('');
  console.log(`Done. scanned=${scanned}, updated=${updated}, skipped=${skipped}, missing=${missing}, failed=${failed}`);
  if (DRY_RUN) console.log('Dry run enabled: no DB rows were written.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
