import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const USE_MY_LOCATION_KEY = 'settings_use_my_location_v1';

interface LocationSettingsContextValue {
  useMyLocation: boolean;
  loading: boolean;
  setUseMyLocation: (enabled: boolean) => Promise<void>;
}

const LocationSettingsContext = createContext<LocationSettingsContextValue | null>(null);

export function LocationSettingsProvider({ children }: { children: React.ReactNode }) {
  const [useMyLocation, setUseMyLocationState] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(USE_MY_LOCATION_KEY);
        if (cancelled) return;
        if (raw === 'false') {
          setUseMyLocationState(false);
        } else {
          setUseMyLocationState(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setUseMyLocation = useCallback(async (enabled: boolean) => {
    setUseMyLocationState(enabled);
    await AsyncStorage.setItem(USE_MY_LOCATION_KEY, enabled ? 'true' : 'false');
  }, []);

  const value = useMemo(
    () => ({ useMyLocation, loading, setUseMyLocation }),
    [useMyLocation, loading, setUseMyLocation],
  );

  return (
    <LocationSettingsContext.Provider value={value}>
      {children}
    </LocationSettingsContext.Provider>
  );
}

export function useLocationSettings(): LocationSettingsContextValue {
  const ctx = useContext(LocationSettingsContext);
  if (!ctx) throw new Error('useLocationSettings must be used inside LocationSettingsProvider');
  return ctx;
}
