import * as Location from 'expo-location';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import type { Cafe } from '../types';
import {
  enrichCafesWithDistance,
  fetchCafesFromOverpass,
  loadCachedCafes,
  saveCachedCafes,
} from '../services/cafe-repository';

interface CafeDataContextValue {
  cafes: Cafe[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
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
  const [cafes, setCafes] = useState<Cafe[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const currentLocation = await getCurrentLocation();
      const fresh = await fetchCafesFromOverpass();
      const withDistance = enrichCafesWithDistance(fresh, currentLocation);
      setCafes(withDistance);
      await saveCachedCafes(withDistance);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Cafe refresh failed';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

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
    let cancelled = false;
    (async () => {
      try {
        const currentLocation = await getCurrentLocation();
        const cached = await loadCachedCafes();
        if (!cancelled && cached?.length) {
          const cachedWithDistance = enrichCafesWithDistance(cached, currentLocation);
          setCafes(cachedWithDistance);
          await saveCachedCafes(cachedWithDistance);
        }
      } catch {
        // Ignore cache read errors and continue with network refresh.
      } finally {
        if (!cancelled) void refresh();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const value = useMemo(
    () => ({ cafes, loading, error, refresh, updateSunStatus }),
    [cafes, loading, error, refresh, updateSunStatus],
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
