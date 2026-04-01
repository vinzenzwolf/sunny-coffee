import React, { createContext, useContext, useEffect, useState } from 'react';
import * as WebBrowser from 'expo-web-browser';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../services/supabase';

WebBrowser.maybeCompleteAuthSession();

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signInWithGoogle = async () => {
    const redirectTo = 'sunnycoffee://auth/callback';

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
        skipBrowserRedirect: true,
      },
    });

    if (error || !data.url) return;

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);

    if (result.type === 'success') {
      const raw = result.url;

      // Supabase implicit flow: tokens arrive in the hash fragment
      const accessTokenMatch = raw.match(/access_token=([^&]+)/);
      const refreshTokenMatch = raw.match(/refresh_token=([^&]+)/);

      if (accessTokenMatch && refreshTokenMatch) {
        const { data, error } = await supabase.auth.setSession({
          access_token: decodeURIComponent(accessTokenMatch[1]),
          refresh_token: decodeURIComponent(refreshTokenMatch[1]),
        });
        if (!error) {
          setSession(data.session);
          setUser(data.session?.user ?? null);
        }
      } else {
        // PKCE flow fallback: code in query params
        const codeMatch = raw.match(/[?&#]code=([^&]+)/);
        if (codeMatch) {
          await supabase.auth.exchangeCodeForSession(decodeURIComponent(codeMatch[1]));
        }
        const { data } = await supabase.auth.getSession();
        setSession(data.session);
        setUser(data.session?.user ?? null);
      }
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
