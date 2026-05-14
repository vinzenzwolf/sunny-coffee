/**
 * Compute sun-window intervals for all cafés today using the ShadeMap SDK via Puppeteer.
 *
 * Install dep first:  npm install puppeteer
 * Run:                npx tsx scripts/compute-sun-windows-shademap.ts
 *
 * Required env vars (reads from .env automatically):
 *   EXPO_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   EXPO_PUBLIC_SHADEMAP_API_KEY
 *
 * ShadeMap approach:
 *   _generateShadeProfile(locations[], dates[]) → Uint8ClampedArray
 *   Bitmap layout: output[(date_idx * n_locations + location_idx) * 4]
 *   R channel: 0 = shade, nonzero = sun
 */

import puppeteer from 'puppeteer';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import SunCalc from 'suncalc';

// ── env ───────────────────────────────────────────────────────────────────────

const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (m) (process.env as Record<string, string>)[m[1]] ??= m[2].replace(/^['"]|['"]$/g, '');
  }
}

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SHADEMAP_API_KEY = process.env.EXPO_PUBLIC_SHADEMAP_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !SHADEMAP_API_KEY) {
  console.error('Missing env vars: EXPO_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EXPO_PUBLIC_SHADEMAP_API_KEY');
  process.exit(1);
}

// ── constants ─────────────────────────────────────────────────────────────────

const SLOT_MINUTES = 5;
const TOTAL_SLOTS = (24 * 60) / SLOT_MINUTES; // 288
const COPENHAGEN = { lat: 55.6761, lng: 12.5683 };
const MIN_SUN_ALT_DEG = 1.0;
const MAPLIBRE_VER = '4.7.1';

// ── types ─────────────────────────────────────────────────────────────────────

interface Cafe { id: string; name: string; lat: number; lng: number; }
interface SunInterval { start: string; end: string; }

// ── date helpers ──────────────────────────────────────────────────────────────

function getTodayDateStr(): string {
  // Copenhagen = UTC+2 in summer (CEST)
  const d = new Date(Date.now() + 2 * 60 * 60 * 1000);
  return d.toISOString().split('T')[0];
}

function slotDate(dateStr: string, slot: number): Date {
  const minutes = slot * SLOT_MINUTES;
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return new Date(`${dateStr}T${h}:${m}:00+02:00`);
}

function slotToTimeStr(slot: number): string {
  const m = slot * SLOT_MINUTES;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function buildIntervals(inSun: boolean[]): SunInterval[] {
  const out: SunInterval[] = [];
  let start: number | null = null;
  for (let i = 0; i <= inSun.length; i++) {
    const sunny = i < inSun.length && inSun[i];
    if (sunny && start === null) { start = i; }
    else if (!sunny && start !== null) {
      out.push({ start: slotToTimeStr(start), end: slotToTimeStr(i) });
      start = null;
    }
  }
  return out;
}

// ── Supabase helpers ──────────────────────────────────────────────────────────

async function fetchAllCafes(sb: SupabaseClient): Promise<Cafe[]> {
  const cafes: Cafe[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await sb
      .from('cafes')
      .select('id, name, lat, lng')
      .range(offset, offset + 999);
    if (error) throw new Error(`Supabase cafes: ${error.message}`);
    cafes.push(...(data as Cafe[]));
    if (data.length < 1000) break;
    offset += 1000;
  }
  return cafes;
}

async function upsertSunWindows(
  sb: SupabaseClient,
  rows: { cafe_id: string; date: string; intervals: SunInterval[] }[],
): Promise<void> {
  const now = new Date().toISOString();
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200).map(r => ({
      cafe_id: r.cafe_id,
      date: r.date,
      intervals: r.intervals,
      computed_at: now,
    }));
    const { error } = await sb.from('sun_windows').upsert(batch, { onConflict: 'cafe_id,date' });
    if (error) throw new Error(`Supabase upsert: ${error.message}`);
  }
}

// ── Terminal progress ─────────────────────────────────────────────────────────

function progressBar(done: number, total: number, width = 30): string {
  const filled = Math.round((done / total) * width);
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
}

function renderProgress(done: number, total: number, elapsedMs: number, batchMs: number) {
  const pct = Math.round((done / total) * 100);
  const elapsed = (elapsedMs / 1000).toFixed(1);
  const perSlot = done > 0 ? (elapsedMs / done).toFixed(0) : '—';
  const eta = done > 0 ? (((total - done) * elapsedMs) / done / 1000).toFixed(1) : '—';
  const line =
    `  ${progressBar(done, total)} ${String(pct).padStart(3)}%` +
    `  ${done}/${total} slots` +
    `  ${elapsed}s elapsed  ~${perSlot}ms/slot  ETA ${eta}s`;
  process.stdout.write('\r' + line.padEnd(100));
}

// ── ShadeMap via Puppeteer ────────────────────────────────────────────────────

const BATCH_SIZE = 20; // slots per _generateShadeProfile call

async function computeShadeProfile(
  cafes: Cafe[],
  slotDates: Date[],
  apiKey: string,
): Promise<Uint8ClampedArray> {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-gl=swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 2048, height: 2048 });
    page.on('console', msg => {
      if (msg.type() === 'error') process.stderr.write('\n[page error] ' + msg.text() + '\n');
    });

    const html = `<!DOCTYPE html>
<html>
<head>
  <style>*{margin:0;padding:0} html,body,#map{width:2048px;height:2048px;}</style>
  <link rel="stylesheet" href="https://unpkg.com/maplibre-gl@${MAPLIBRE_VER}/dist/maplibre-gl.css">
  <script src="https://unpkg.com/maplibre-gl@${MAPLIBRE_VER}/dist/maplibre-gl.js"></script>
  <script src="https://unpkg.com/mapbox-gl-shadow-simulator/dist/mapbox-gl-shadow-simulator.umd.min.js"></script>
</head>
<body>
  <div id="map"></div>
  <script>
    window._ready = false;
    window._shadeMap = null;

    const map = new maplibregl.Map({
      container: 'map',
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [${COPENHAGEN.lng}, ${COPENHAGEN.lat}],
      zoom: 13,
      interactive: false,
      fadeDuration: 0,
    });

    const shadeMap = ShadeMap({
      apiKey: '${apiKey}',
      date: new Date(),
      color: '#000000',
      opacity: 1.0,
      terrainSource: {
        maxzoom: 15,
        tileSize: 256,
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        type: 'raster',
        minzoom: 5,
      },
      getFeatures: async () => [],
    }).addTo(map);

    map.on('load', () => {
      window._shadeMap = shadeMap;
      window._ready = true;
    });
  </script>
</body>
</html>`;

    process.stdout.write('  Browser init: loading MapLibre + ShadeMap...');
    const tInit = Date.now();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60_000 });
    await page.waitForFunction('window._ready === true', { timeout: 30_000 });
    process.stdout.write(` done (${((Date.now() - tInit) / 1000).toFixed(1)}s)\n`);

    const locations = cafes.map(c => ({ lng: c.lng, lat: c.lat }));

    // Accumulate full bitmap: [n_slots × n_cafes] RGBA pixels
    const totalSlots = slotDates.length;
    const bitmapOut = new Uint8ClampedArray(totalSlots * cafes.length * 4);

    const tCompute = Date.now();
    let doneSlots = 0;

    for (let batchStart = 0; batchStart < totalSlots; batchStart += BATCH_SIZE) {
      const batchDates = slotDates.slice(batchStart, batchStart + BATCH_SIZE);
      const datesMs = batchDates.map(d => d.getTime());
      const tBatch = Date.now();

      const flat = await page.evaluate(
        async (locs, datesMs) => {
          const dates = (datesMs as number[]).map((ms: number) => new Date(ms));
          const out = await (window as any)._shadeMap._generateShadeProfile({
            locations: locs,
            dates,
            sunColor: [255, 255, 255, 255],
            shadeColor: [0, 0, 0, 255],
          });
          return Array.from(out as Uint8ClampedArray);
        },
        locations,
        datesMs,
      );

      // Write batch results into the full bitmap at the correct offset
      const batchData = new Uint8ClampedArray(flat as number[]);
      bitmapOut.set(batchData, batchStart * cafes.length * 4);

      doneSlots += batchDates.length;
      renderProgress(doneSlots, totalSlots, Date.now() - tCompute, Date.now() - tBatch);
    }

    process.stdout.write('\n');
    return bitmapOut;
  } finally {
    await browser.close();
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log('=== compute-sun-windows-shademap ===');

  const dateStr = getTodayDateStr();
  console.log(`Date: ${dateStr}`);

  const sb = createClient(SUPABASE_URL!, SUPABASE_SERVICE_KEY!);

  console.log('Fetching cafés...');
  const cafes = await fetchAllCafes(sb);
  console.log(`${cafes.length} cafés loaded`);
  if (!cafes.length) { console.warn('No cafés — run cafe sync first'); return; }

  // Slots where sun is above horizon (prefilter to avoid useless ShadeMap calls)
  const sunSlots: number[] = [];
  for (let slot = 0; slot < TOTAL_SLOTS; slot++) {
    const dt = slotDate(dateStr, slot);
    const pos = SunCalc.getPosition(dt, COPENHAGEN.lat, COPENHAGEN.lng);
    if ((pos.altitude * 180) / Math.PI >= MIN_SUN_ALT_DEG) sunSlots.push(slot);
  }
  const slotDates = sunSlots.map(s => slotDate(dateStr, s));
  console.log(`${slotDates.length} slots with sun above horizon`);

  if (!slotDates.length) { console.warn('No daylight today'); return; }

  // Compute
  console.log(`Computing via ShadeMap (${cafes.length} cafés × ${slotDates.length} slots, batch=${BATCH_SIZE})...`);
  const bitmap = await computeShadeProfile(cafes, slotDates, SHADEMAP_API_KEY!);

  // Parse bitmap → per-café intervals
  // Layout: bitmap[(date_idx * n_cafes + cafe_idx) * 4] — R channel
  const results = cafes.map((cafe, ci) => {
    const inSun = new Array<boolean>(TOTAL_SLOTS).fill(false);
    for (let di = 0; di < sunSlots.length; di++) {
      inSun[sunSlots[di]] = bitmap[(di * cafes.length + ci) * 4] !== 0;
    }
    return { cafe_id: cafe.id, date: dateStr, intervals: buildIntervals(inSun) };
  });

  // Print sample for inspection
  console.log('\nSample results:');
  results.slice(0, 5).forEach(r => {
    const cafe = cafes.find(c => c.id === r.cafe_id);
    console.log(`  ${cafe?.name}: ${JSON.stringify(r.intervals)}`);
  });

  // Upsert
  console.log(`\nUpserting ${results.length} sun windows to Supabase...`);
  await upsertSunWindows(sb, results);

  console.log(`\n=== Done in ${((Date.now() - t0) / 1000).toFixed(1)}s total ===`);
}

main().catch(e => { console.error(e); process.exit(1); });
