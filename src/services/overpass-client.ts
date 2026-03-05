/**
 * Overpass API client
 *
 * Responsibilities:
 *  - Build and execute an Overpass QL query for building footprints within a
 *    given bounding box.
 *  - Convert the Overpass JSON response to a GeoJSON FeatureCollection.
 *  - Apply height logic: tag `height` → metres, `building:levels` × 3 m,
 *    otherwise default 9 m (3 storeys) and mark as estimated.
 *  - Cache results keyed by a snapped bbox + zoom to avoid hammering the API.
 *  - Retry with exponential backoff on HTTP 429 / 5xx.
 *  - Enforce a 2 000 feature limit; log a warning if the server returns more.
 */

import type { BBox, BuildingCollection, BuildingFeature, BuildingProperties } from '../types';
import { simplifyRing } from '../utils/geometry';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const MAX_FEATURES = 2_000;
/** Douglas-Peucker tolerance in degrees (≈ 0.5 m at mid-latitudes). */
const SIMPLIFY_EPS = 5e-6;
const CACHE_TTL_MS = 5 * 60 * 1_000; // 5 minutes
const REQUEST_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  data: BuildingCollection;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Snap a bbox to a coarse grid so that slightly different viewports hit the
 * same cache entry.  Grid resolution decreases with zoom (wider at low zoom).
 */
function cacheKey(bbox: BBox, zoom: number): string {
  // Resolution: ~1 tile width at the given zoom level (rough heuristic)
  const res = 360 / Math.pow(2, Math.max(zoom, 8));
  const snap = (v: number) => Math.round(v / res) * res;
  return [snap(bbox.west), snap(bbox.south), snap(bbox.east), snap(bbox.north)].join(',');
}

function getCached(bbox: BBox, zoom: number): BuildingCollection | null {
  const entry = cache.get(cacheKey(bbox, zoom));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(cacheKey(bbox, zoom));
    return null;
  }
  return entry.data;
}

function setCached(bbox: BBox, zoom: number, data: BuildingCollection): void {
  cache.set(cacheKey(bbox, zoom), { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// Overpass query builder
// ---------------------------------------------------------------------------

function buildQuery(bbox: BBox): string {
  const { south, west, north, east } = bbox;
  // [maxsize] keeps memory usage reasonable; [timeout] avoids long-running queries.
  return `[out:json][timeout:20][maxsize:10000000];
(
  way["building"](${south},${west},${north},${east});
);
out body;
>;
out skel qt;`;
}

// ---------------------------------------------------------------------------
// Overpass JSON → GeoJSON conversion
// ---------------------------------------------------------------------------

interface OverpassNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
}

interface OverpassWay {
  type: 'way';
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
}

type OverpassElement = OverpassNode | OverpassWay;

interface OverpassResponse {
  elements: OverpassElement[];
}

function resolveHeight(tags: Record<string, string> | undefined): {
  height_m: number;
  estimated: boolean;
} {
  if (!tags) return { height_m: 9.0, estimated: true };

  const rawHeight = tags['height'];
  if (rawHeight) {
    const parsed = parseFloat(rawHeight);
    if (!isNaN(parsed) && parsed > 0) {
      return { height_m: parsed, estimated: false };
    }
  }

  const levels = tags['building:levels'];
  if (levels) {
    const parsed = parseInt(levels, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return { height_m: parsed * 3.0, estimated: false };
    }
  }

  return { height_m: 9.0, estimated: true };
}

function overpassToGeoJSON(response: OverpassResponse): BuildingCollection {
  // Build a fast node-id → coordinate lookup
  const nodes = new Map<number, [number, number]>();
  for (const el of response.elements) {
    if (el.type === 'node') {
      nodes.set(el.id, [el.lon, el.lat]);
    }
  }

  const features: BuildingFeature[] = [];

  for (const el of response.elements) {
    if (el.type !== 'way') continue;
    if (features.length >= MAX_FEATURES) {
      console.warn(`[Overpass] Reached ${MAX_FEATURES} feature limit – truncating results.`);
      break;
    }

    const ring: [number, number][] = [];
    for (const nodeId of el.nodes) {
      const coord = nodes.get(nodeId);
      if (coord) ring.push(coord);
    }

    // Need at least 3 distinct points + close (≥ 4 total)
    if (ring.length < 3) continue;

    // Ensure ring is closed
    if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
      ring.push(ring[0]);
    }

    const simplified = simplifyRing(ring, SIMPLIFY_EPS);
    if (simplified.length < 4) continue;

    const { height_m, estimated } = resolveHeight(el.tags);

    const props: BuildingProperties = {
      id: `way/${el.id}`,
      height_m,
      height_estimated: estimated,
      osm_height: el.tags?.['height'],
      osm_building_levels: el.tags?.['building:levels'],
    };

    features.push({
      type: 'Feature',
      id: el.id,
      geometry: { type: 'Polygon', coordinates: [simplified] },
      properties: props,
    });
  }

  return { type: 'FeatureCollection', features };
}

// ---------------------------------------------------------------------------
// HTTP fetch with exponential backoff
// ---------------------------------------------------------------------------

async function fetchWithRetry(
  url: string,
  body: string,
  maxAttempts = 3,
): Promise<OverpassResponse> {
  let attempt = 0;
  let lastError: Error = new Error('Unknown error');

  while (attempt < maxAttempts) {
    attempt++;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(body)}`,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (res.status === 429 || res.status >= 500) {
        const backoff = 1_000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
        console.warn(`[Overpass] HTTP ${res.status} – retrying in ${backoff}ms (attempt ${attempt}/${maxAttempts})`);
        await new Promise((resolve) => setTimeout(resolve, backoff));
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      return (await res.json()) as OverpassResponse;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === 'AbortError') {
        lastError = new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      } else {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
      if (attempt < maxAttempts) {
        const backoff = 1_000 * Math.pow(2, attempt - 1);
        console.warn(`[Overpass] Error: ${lastError.message} – retrying in ${backoff}ms`);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch building footprints for the given bounding box.
 *
 * Results are cached per bbox+zoom for 5 minutes.  The function throws on
 * network or parse errors – callers should handle gracefully.
 *
 * @param bbox  Map viewport bounding box.
 * @param zoom  Current map zoom level (used only for cache granularity).
 */
export async function fetchBuildings(bbox: BBox, zoom: number): Promise<BuildingCollection> {
  const cached = getCached(bbox, zoom);
  if (cached) {
    console.log(`[Overpass] Cache hit (${cached.features.length} features)`);
    return cached;
  }

  const query = buildQuery(bbox);
  console.log('[Overpass] Fetching buildings…', { bbox, zoom });

  const response = await fetchWithRetry(OVERPASS_ENDPOINT, query);
  const collection = overpassToGeoJSON(response);

  console.log(`[Overpass] Loaded ${collection.features.length} buildings`);
  setCached(bbox, zoom, collection);

  return collection;
}

/** Clear the entire in-memory cache (e.g. when app goes to background). */
export function clearBuildingCache(): void {
  cache.clear();
}
