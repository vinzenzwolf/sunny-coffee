import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Cafe } from '../types';
import { supabase } from './supabase';

const CAFE_STORAGE_KEY = 'cafes_cache_v1';

type SupabaseCafeRow = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  opening_hours?: string | null;
  google_formatted_address?: string | null;
};

type SupabaseSunWindowRow = {
  cafe_id: string;
  intervals: unknown;
};

type SupabaseCafeHourRow = {
  cafe_id: string;
  day: string;
  open: string;
  close: string;
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

function copenhagenTodayDateString(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

function normalizeIntervals(input: unknown): { start: string; end: string }[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((item): item is { start: string; end: string } => (
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { start?: unknown }).start === 'string' &&
      typeof (item as { end?: unknown }).end === 'string'
    ))
    .map((item) => ({ start: item.start, end: item.end }));
}

function dayToken(day: string): string | null {
  switch ((day || '').toLowerCase()) {
    case 'monday': return 'Mo';
    case 'tuesday': return 'Tu';
    case 'wednesday': return 'We';
    case 'thursday': return 'Th';
    case 'friday': return 'Fr';
    case 'saturday': return 'Sa';
    case 'sunday': return 'Su';
    default: return null;
  }
}

function openingHoursByCafeId(rows: SupabaseCafeHourRow[]): Map<string, string> {
  const byCafe = new Map<string, Partial<Record<'Mo' | 'Tu' | 'We' | 'Th' | 'Fr' | 'Sa' | 'Su', string>>>();

  for (const row of rows) {
    const token = dayToken(row.day);
    if (!token) continue;
    if (typeof row.open !== 'string' || typeof row.close !== 'string') continue;
    const current = byCafe.get(row.cafe_id) ?? {};
    current[token as 'Mo' | 'Tu' | 'We' | 'Th' | 'Fr' | 'Sa' | 'Su'] = `${row.open}-${row.close}`;
    byCafe.set(row.cafe_id, current);
  }

  const out = new Map<string, string>();
  const order: ('Mo' | 'Tu' | 'We' | 'Th' | 'Fr' | 'Sa' | 'Su')[] = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

  for (const [cafeId, schedule] of byCafe.entries()) {
    const rules = order
      .filter((d) => typeof schedule[d] === 'string')
      .map((d) => `${d} ${schedule[d]}`);
    if (rules.length) out.set(cafeId, rules.join('; '));
  }

  return out;
}

function rowToCafe(
  row: SupabaseCafeRow,
  sunWindowsByCafeId: Map<string, { start: string; end: string }[]>,
  openingHoursMap: Map<string, string>,
): Cafe {
  const sunWindows = sunWindowsByCafeId.get(row.id) ?? [];
  return {
    id: row.id,
    name: row.name || 'Cafe',
    lat: row.lat,
    lng: row.lng,
    googleFormattedAddress: row.google_formatted_address,
    metadata: {
      openingHours: row.opening_hours ?? openingHoursMap.get(row.id),
      sunWindows,
    },
  };
}

export async function fetchCafesFromSupabase(): Promise<Cafe[]> {
  const today = copenhagenTodayDateString();
  const [cafesRes, sunRes] = await Promise.all([
    (async () => {
      const primary = await supabase
        .from('cafes')
        .select('id, name, lat, lng, opening_hours, google_formatted_address');
      if (!primary.error) return primary;
      if (primary.error.code !== '42703') return primary;
      // Fallback for schemas that do not have opening_hours.
      return supabase
        .from('cafes')
        .select('id, name, lat, lng, google_formatted_address');
    })(),
    supabase
      .from('sun_windows')
      .select('cafe_id, intervals')
      .eq('date', today),
  ]);
  const hoursRes = await supabase
    .from('cafe_hours')
    .select('cafe_id, day, open, close');

  if (cafesRes.error) throw new Error(cafesRes.error.message);

  const sunRows = sunRes.error ? [] : ((sunRes.data ?? []) as SupabaseSunWindowRow[]);
  const hourRows = hoursRes.error ? [] : ((hoursRes.data ?? []) as SupabaseCafeHourRow[]);

  const sunWindowsByCafeId = new Map<string, { start: string; end: string }[]>();
  for (const row of sunRows) {
    sunWindowsByCafeId.set(row.cafe_id, normalizeIntervals(row.intervals));
  }

  const hoursMap = openingHoursByCafeId(hourRows);

  return ((cafesRes.data ?? []) as SupabaseCafeRow[]).map((row) =>
    rowToCafe(row, sunWindowsByCafeId, hoursMap),
  );
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
  if (!currentLocation) {
    return cafes.map((cafe) => {
      if (!cafe.metadata) return cafe;
      const {
        distanceMeters: _distanceMeters,
        distanceKm: _distanceKm,
        distanceUpdatedAt: _distanceUpdatedAt,
        distanceFrom: _distanceFrom,
        ...metadataWithoutDistance
      } = cafe.metadata;
      return {
        ...cafe,
        metadata: metadataWithoutDistance,
      };
    });
  }

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
