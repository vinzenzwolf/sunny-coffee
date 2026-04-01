import type { Feature, FeatureCollection, Polygon, MultiPolygon, Position } from 'geojson';

export type { Position };

// ---------------------------------------------------------------------------
// Bounding box
// ---------------------------------------------------------------------------

export interface BBox {
  north: number;
  south: number;
  east: number;
  west: number;
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

export interface BuildingProperties {
  /** Stable OSM element id, e.g. "way/123456" */
  id: string;
  /** Resolved height in metres (from tag or estimate) */
  height_m: number;
  /** True when height was not found in OSM tags and a default was applied */
  height_estimated: boolean;
  /** Raw OSM tag value, kept for debugging */
  osm_height?: string;
  osm_building_levels?: string;
}

export type BuildingFeature = Feature<Polygon | MultiPolygon, BuildingProperties>;
export type BuildingCollection = FeatureCollection<Polygon | MultiPolygon, BuildingProperties>;

// ---------------------------------------------------------------------------
// Sun position
// ---------------------------------------------------------------------------

export interface SunPosition {
  /** Altitude above horizon in radians (0 = horizon, π/2 = zenith) */
  altitudeRad: number;
  /**
   * Azimuth in SunCalc convention: measured from south towards west.
   * 0 = south, π/2 = west, ±π = north, -π/2 = east.
   */
  azimuthRad: number;
  /** Convenience flag: true when the sun is meaningfully above the horizon */
  isAboveHorizon: boolean;
}

// ---------------------------------------------------------------------------
// Shadows
// ---------------------------------------------------------------------------

/**
 * Which rendering backend to use.
 *
 * 'client'  – shadows are computed locally from OSM building geometry
 *             (free, works offline once buildings are loaded).
 * 'api'     – ShadeMap raster tiles are fetched and overlaid as an image layer
 *             (requires EXPO_PUBLIC_SHADEMAP_API_KEY).
 */
export type ShadowMode = 'client' | 'api';

export interface ShadowResult {
  mode: ShadowMode;
  /** Populated when mode === 'client' */
  shadowPolygons?: FeatureCollection<Polygon>;
  /** Tile URL template populated when mode === 'api' */
  tileUrlTemplate?: string;
  /** Unix timestamp of the shadow calculation */
  computedAt: number;
}

// ---------------------------------------------------------------------------
// Map camera / region
// ---------------------------------------------------------------------------

export interface MapRegion {
  latitude: number;
  longitude: number;
  zoom: number;
}

// ---------------------------------------------------------------------------
// Toasts / status messages
// ---------------------------------------------------------------------------

export type ToastLevel = 'info' | 'warning' | 'error';

export interface ToastMessage {
  id: string;
  message: string;
  level: ToastLevel;
}

// ---------------------------------------------------------------------------
// Cafes
// ---------------------------------------------------------------------------

export interface CafeMetadata {
  openingHours?: string;
  sunWindows?: { start: string; end: string }[];
  distanceMeters?: number;
  distanceKm?: number;
  distanceUpdatedAt?: number;
  distanceFrom?: { lat: number; lng: number };
  inSunNow?: boolean;
  sunStatusUpdatedAt?: number;
}

export interface Cafe {
  id: string;
  name: string;
  lat: number;
  lng: number;
  googleFormattedAddress?: string | null;
  metadata?: CafeMetadata;
}
