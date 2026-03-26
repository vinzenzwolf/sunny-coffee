import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Cafe } from '../types';

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const COPENHAGEN_BBOX = { south: 55.60, west: 12.45, north: 55.74, east: 12.73 };
const CAFE_STORAGE_KEY = 'cafes_cache_v1';
const REQUEST_TIMEOUT_MS = 20_000;

type OverpassElement = {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
};

type OverpassResponse = {
  elements?: OverpassElement[];
};

type GeoPoint = {
  lat: number;
  lng: number;
};

type CafeCachePayload = {
  version: 1;
  fetchedAt: number;
  cafes: Cafe[];
};

function buildCafeQuery() {
  const { south, west, north, east } = COPENHAGEN_BBOX;
  return `[out:json][timeout:20];
(
  node["amenity"="cafe"](${south},${west},${north},${east});
  way["amenity"="cafe"](${south},${west},${north},${east});
  relation["amenity"="cafe"](${south},${west},${north},${east});
);
out center tags;`;
}

function resolveArea(tags: Record<string, string> | undefined): string | undefined {
  if (!tags) return undefined;
  return (
    tags['addr:suburb'] ||
    tags['addr:neighbourhood'] ||
    tags['addr:city_district'] ||
    tags['addr:city'] ||
    undefined
  );
}

function resolveOpeningHours(tags: Record<string, string>): string | undefined {
  return (
    tags['opening_hours'] ||
    tags['contact:opening_hours'] ||
    undefined
  );
}

function normalizeCafe(el: OverpassElement): Cafe | null {
  const lng = typeof el.lon === 'number' ? el.lon : el.center?.lon;
  const lat = typeof el.lat === 'number' ? el.lat : el.center?.lat;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;

  const tags = el.tags ?? {};
  return {
    id: `${el.type}/${el.id}`,
    name: tags['name'] || 'Cafe',
    lat,
    lng,
    area: resolveArea(tags),
    metadata: {
      cuisine: tags['cuisine'],
      openingHours: resolveOpeningHours(tags),
      website: tags['website'] || tags['contact:website'],
      sourceType: el.type,
      rawTags: tags,
    },
  };
}

export async function fetchCafesFromOverpass(): Promise<Cafe[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(OVERPASS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: `data=${encodeURIComponent(buildCafeQuery())}`,
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as OverpassResponse;
    const elements = Array.isArray(json.elements) ? json.elements : [];
    const cafes = elements
      .map(normalizeCafe)
      .filter((cafe): cafe is Cafe => cafe !== null);

    return cafes;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function saveCachedCafes(cafes: Cafe[]): Promise<void> {
  const payload: CafeCachePayload = {
    version: 1,
    fetchedAt: Date.now(),
    cafes,
  };
  await AsyncStorage.setItem(CAFE_STORAGE_KEY, JSON.stringify(payload));
}

export async function loadCachedCafes(): Promise<Cafe[] | null> {
  const raw = await AsyncStorage.getItem(CAFE_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CafeCachePayload>;
    if (parsed.version !== 1 || !Array.isArray(parsed.cafes)) return null;
    return parsed.cafes;
  } catch {
    return null;
  }
}

function haversineDistanceMeters(from: GeoPoint, to: GeoPoint): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(to.lat - from.lat);
  const dLng = toRad(to.lng - from.lng);
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function enrichCafesWithDistance(
  cafes: Cafe[],
  currentLocation: GeoPoint | null,
  updatedAt = Date.now(),
): Cafe[] {
  if (!currentLocation) return cafes;

  return cafes.map((cafe) => {
    const distanceMeters = haversineDistanceMeters(currentLocation, {
      lat: cafe.lat,
      lng: cafe.lng,
    });
    return {
      ...cafe,
      metadata: {
        ...(cafe.metadata ?? {}),
        distanceMeters: Math.round(distanceMeters),
        distanceKm: Number((distanceMeters / 1000).toFixed(2)),
        distanceUpdatedAt: updatedAt,
        distanceFrom: {
          lat: currentLocation.lat,
          lng: currentLocation.lng,
        },
      },
    };
  });
}
