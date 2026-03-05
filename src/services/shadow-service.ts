/**
 * Shadow service
 *
 * Primary mode: ShadeMap raster tile API
 * ──────────────────────────────────────
 * ShadeMap renders building + terrain shadows server-side and exposes them as
 * standard XYZ raster tiles.  We pass the tile URL template directly to a
 * MapLibre RasterSource, which handles tile fetching and caching.
 *
 * Tile URL format:
 *   https://tiles.shademap.app/{z}/{x}/{y}?key=API_KEY&date=UNIX_SECONDS
 *
 * Changing the time updates only the `date` query parameter; MapLibre will
 * reload tiles automatically when we update the source URL.
 *
 * Fallback mode: client-side geometry
 * ─────────────────────────────────────
 * When no API key is configured the service falls back to computing shadow
 * polygons locally.  Algorithm:
 *   1. For each building footprint + height h, and sun altitude β:
 *        shadow_length L = h / tan(β)
 *   2. Project every vertex in the shadow direction by L.
 *   3. Return the convex hull of (original vertices ∪ projected vertices).
 *
 * To permanently switch modes, change `DEFAULT_SHADOW_MODE` below.
 */

import type { FeatureCollection, Polygon } from 'geojson';
import type {
  BBox,
  BuildingCollection,
  ShadowMode,
  ShadowResult,
  SunPosition,
} from '../types';
import { convexHull, metresToDegrees } from '../utils/geometry';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Change to 'client' to always use local computation (no API key needed). */
export const DEFAULT_SHADOW_MODE: ShadowMode =
  (process.env['EXPO_PUBLIC_SHADOW_MODE'] as ShadowMode | undefined) ?? 'api';

/** Shadows longer than this are skipped (sun near horizon, near-infinite lengths). */
const MAX_SHADOW_LENGTH_M = 400;

/** Sun must be at least this high for client-side shadows (radians ≈ 1°). */
const MIN_SUN_ALTITUDE_RAD = 0.017;

// ---------------------------------------------------------------------------
// ShadeMap raster tile URL
// ---------------------------------------------------------------------------

const SHADEMAP_TILE_BASE = 'https://tiles.shademap.app';

/**
 * Build a MapLibre-compatible XYZ tile URL template for the ShadeMap API.
 *
 * The `{z}/{x}/{y}` placeholders are resolved by MapLibre's raster source.
 * `date` is a Unix timestamp in **seconds** representing the exact moment.
 *
 * @see https://shademap.app/about
 */
export function buildShadeMapTileUrl(date: Date, apiKey: string): string {
  const unixSec = Math.floor(date.getTime() / 1_000);
  return `${SHADEMAP_TILE_BASE}/{z}/{x}/{y}?key=${encodeURIComponent(apiKey)}&date=${unixSec}`;
}

// ---------------------------------------------------------------------------
// Client-side shadow computation (fallback)
// ---------------------------------------------------------------------------

function projectRing(
  ring: number[][],
  dLon: number,
  dLat: number,
): number[][] | null {
  const open =
    ring[ring.length - 1][0] === ring[0][0] && ring[ring.length - 1][1] === ring[0][1]
      ? ring.slice(0, -1)
      : ring;

  if (open.length < 3) return null;

  const projected = open.map(([lon, lat]) => [lon + dLon, lat + dLat]);
  const hull = convexHull([...open, ...projected] as [number, number][]);
  return hull.length >= 4 ? hull : null;
}

function computeClientShadows(
  buildings: BuildingCollection,
  sun: SunPosition,
  refLatDeg: number,
): FeatureCollection<Polygon> {
  const features: FeatureCollection<Polygon>['features'] = [];

  if (!sun.isAboveHorizon || sun.altitudeRad < MIN_SUN_ALTITUDE_RAD) {
    return { type: 'FeatureCollection', features };
  }

  // Metres of shadow per metre of building height
  const lengthPerMetre = Math.min(
    1 / Math.tan(sun.altitudeRad),
    MAX_SHADOW_LENGTH_M,
  );

  // Shadow direction: opposite the sun (north-based azimuth)
  const shadowDirLonUnit = -Math.sin(sun.azimuthRad);
  const shadowDirLatUnit = -Math.cos(sun.azimuthRad);

  for (const feature of buildings.features) {
    const { height_m } = feature.properties;
    const lengthM = height_m * lengthPerMetre;

    const { dLon, dLat } = metresToDegrees(
      shadowDirLonUnit * lengthM,
      shadowDirLatUnit * lengthM,
      refLatDeg,
    );

    const rings =
      feature.geometry.type === 'Polygon'
        ? feature.geometry.coordinates
        : feature.geometry.coordinates.flatMap((p) => p);

    // Only project outer rings
    const outerRings =
      feature.geometry.type === 'Polygon'
        ? [rings[0]]
        : feature.geometry.coordinates.map((p) => p[0]);

    for (const ring of outerRings) {
      const hull = projectRing(ring as number[][], dLon, dLat);
      if (!hull) continue;

      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [hull] },
        properties: { buildingId: feature.properties.id, height_m },
      });
    }
  }

  return { type: 'FeatureCollection', features };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ComputeShadowsOptions {
  /** Which backend to use. Defaults to DEFAULT_SHADOW_MODE. */
  mode?: ShadowMode;
  /** Required for client mode; also used in API mode for UI-only purposes. */
  buildings: BuildingCollection;
  sun: SunPosition;
  date: Date;
  bbox: BBox;
  /**
   * ShadeMap API key.  Falls back to EXPO_PUBLIC_SHADEMAP_API_KEY env var.
   * If neither is set, the service automatically falls back to client mode.
   */
  shadeMapApiKey?: string;
}

/**
 * Compute or prepare shadow data for the given viewport + time.
 *
 * - Returns a `tileUrlTemplate` when mode === 'api' (plug into MapLibre RasterSource).
 * - Returns `shadowPolygons` (GeoJSON) when mode === 'client'.
 *
 * Falls back to client mode silently when the API key is missing and mode is 'api'.
 */
export function computeShadows(opts: ComputeShadowsOptions): ShadowResult {
  const mode = opts.mode ?? DEFAULT_SHADOW_MODE;
  const { buildings, sun, date, bbox } = opts;

  if (mode === 'api') {
    const apiKey =
      opts.shadeMapApiKey ??
      (process.env['EXPO_PUBLIC_SHADEMAP_API_KEY'] as string | undefined);

    if (apiKey) {
      return {
        mode: 'api',
        tileUrlTemplate: buildShadeMapTileUrl(date, apiKey),
        computedAt: Date.now(),
      };
    }

    // No key configured – fall through to client mode with a warning
    console.warn(
      '[ShadowService] No ShadeMap API key found. ' +
        'Set EXPO_PUBLIC_SHADEMAP_API_KEY in .env for API-based shadows. ' +
        'Falling back to client-side computation.',
    );
  }

  // Client-side fallback
  const refLat = (bbox.north + bbox.south) / 2;
  return {
    mode: 'client',
    shadowPolygons: computeClientShadows(buildings, sun, refLat),
    computedAt: Date.now(),
  };
}
