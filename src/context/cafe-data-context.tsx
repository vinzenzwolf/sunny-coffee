import * as Location from 'expo-location';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import type { Cafe } from '../types';
import { useLocationSettings } from './location-settings-context';
import {
  enrichCafesWithDistance,
  fetchCafesFromSupabase,
  loadCachedCafes,
  saveCachedCafes,
} from '../services/cafe-repository';

interface CafeDataContextValue {
  cafes: Cafe[];
  loading: boolean;
  error: string | null;
  updateSunStatus: (statuses: { id: string; inSun: boolean }[]) => void;
}

const CafeDataContext = createContext<CafeDataContextValue | null>(null);

async function getCurrentLocation(): Promise<{ lat: number; lng: number } | null> {
  const perm = await Location.getForegroundPermissionsAsync();
  if (perm.status !== 'granted') return null;

  try {
    const current = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    return {
      lat: current.coords.latitude,
      lng: current.coords.longitude,
    };
  } catch {
    const last = await Location.getLastKnownPositionAsync();
    if (!last) return null;
    return {
      lat: last.coords.latitude,
      lng: last.coords.longitude,
    };
  }
}

export function CafeDataProvider({ children }: { children: React.ReactNode }) {
  const { useMyLocation, loading: locationSettingsLoading } = useLocationSettings();
  const [cafes, setCafes] = useState<Cafe[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const updateSunStatus = useCallback((statuses: { id: string; inSun: boolean }[]) => {
    if (!statuses.length) return;
    const statusById = new Map(statuses.map((s) => [s.id, s.inSun]));

    setCafes((prev) => {
      const updatedAt = Date.now();
      const next = prev.map((cafe) => {
        const inSun = statusById.get(cafe.id);
        if (typeof inSun !== 'boolean') return cafe;
        return {
          ...cafe,
          metadata: {
            ...(cafe.metadata ?? {}),
            inSunNow: inSun,
            sunStatusUpdatedAt: updatedAt,
          },
        };
      });
      void saveCachedCafes(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (locationSettingsLoading || useMyLocation) return;
    setCafes((prev) => enrichCafesWithDistance(prev, null));
  }, [locationSettingsLoading, useMyLocation]);

  useEffect(() => {
    if (locationSettingsLoading) return;
    let cancelled = false;
    (async () => {
      try {
        const currentLocation = useMyLocation ? await getCurrentLocation() : null;

        // Show cached data immediately while fetching fresh data
        const cached = await loadCachedCafes();
        if (!cancelled && cached?.length) {
          setCafes(enrichCafesWithDistance(cached, currentLocation));
        }

        // Fetch fresh from Supabase
        const fresh = await fetchCafesFromSupabase();
        if (!cancelled) {
          const withDistance = enrichCafesWithDistance(fresh, currentLocation);
          setCafes(withDistance);
          await saveCachedCafes(withDistance);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load cafes');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [locationSettingsLoading, useMyLocation]);

  const value = useMemo(
    () => ({ cafes, loading, error, updateSunStatus }),
    [cafes, loading, error, updateSunStatus],
  );

  return <CafeDataContext.Provider value={value}>{children}</CafeDataContext.Provider>;
}

export function useCafeData(): CafeDataContextValue {
  const ctx = useContext(CafeDataContext);
  if (!ctx) {
    throw new Error('useCafeData must be used inside CafeDataProvider');
  }
  return ctx;
}
