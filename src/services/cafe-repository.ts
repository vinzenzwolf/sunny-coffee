import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Cafe } from '../types';
import { supabase } from './supabase';

const CAFE_STORAGE_KEY = 'cafes_cache_v1';

type SupabaseCafeRow = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  google_formatted_address: string | null;
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

function rowToCafe(row: SupabaseCafeRow): Cafe {
  return {
    id: row.id,
    name: row.name || 'Cafe',
    lat: row.lat,
    lng: row.lng,
    googleFormattedAddress: row.google_formatted_address,
  };
}

export async function fetchCafesFromSupabase(): Promise<Cafe[]> {
  const { data, error } = await supabase
    .from('cafes')
    .select('id, name, lat, lng, google_formatted_address');
  if (error) throw new Error(error.message);
  return (data as SupabaseCafeRow[]).map(rowToCafe);
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
