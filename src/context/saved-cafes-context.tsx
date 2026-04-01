import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useAuth } from './auth-context';
import { supabase } from '../services/supabase';

interface SavedCafesContextValue {
  savedIds: Set<string>;
  isSaved: (cafeId: string) => boolean;
  toggle: (cafeId: string) => Promise<void>;
  loading: boolean;
}

const SavedCafesContext = createContext<SavedCafesContextValue | null>(null);

export function SavedCafesProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!user) {
      setSavedIds(new Set());
      return;
    }

    setLoading(true);
    supabase
      .from('saved_cafes')
      .select('cafe_id')
      .eq('user_id', user.id)
      .then(({ data }) => {
        setSavedIds(new Set((data ?? []).map((r: { cafe_id: string }) => r.cafe_id)));
        setLoading(false);
      });
  }, [user?.id]);

  const toggle = useCallback(async (cafeId: string) => {
    if (!user) return;

    const alreadySaved = savedIds.has(cafeId);

    // Optimistic update
    setSavedIds(prev => {
      const next = new Set(prev);
      if (alreadySaved) next.delete(cafeId);
      else next.add(cafeId);
      return next;
    });

    if (alreadySaved) {
      const { error } = await supabase
        .from('saved_cafes')
        .delete()
        .eq('user_id', user.id)
        .eq('cafe_id', cafeId);

      if (error) {
        setSavedIds(prev => { const next = new Set(prev); next.add(cafeId); return next; });
      }
    } else {
      const { error } = await supabase
        .from('saved_cafes')
        .upsert({ user_id: user.id, cafe_id: cafeId });

      if (error) {
        setSavedIds(prev => { const next = new Set(prev); next.delete(cafeId); return next; });
      }
    }
  }, [user, savedIds]);

  const isSaved = useCallback((cafeId: string) => savedIds.has(cafeId), [savedIds]);

  return (
    <SavedCafesContext.Provider value={{ savedIds, isSaved, toggle, loading }}>
      {children}
    </SavedCafesContext.Provider>
  );
}

export function useSavedCafes(): SavedCafesContextValue {
  const ctx = useContext(SavedCafesContext);
  if (!ctx) throw new Error('useSavedCafes must be used inside SavedCafesProvider');
  return ctx;
}
