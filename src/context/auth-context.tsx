import React, { createContext, useContext, useEffect, useState } from 'react';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../services/supabase';

WebBrowser.maybeCompleteAuthSession();

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithApple: () => Promise<void>;
  signOut: () => Promise<void>;
  deleteAccount: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const processAuthCallback = async (url: string) => {
    if (!url.includes('sunnycoffee://')) return;

    const accessTokenMatch = url.match(/access_token=([^&]+)/);
    const refreshTokenMatch = url.match(/refresh_token=([^&]+)/);

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
      const codeMatch = url.match(/[?&#]code=([^&]+)/);
      if (codeMatch) {
        await supabase.auth.exchangeCodeForSession(decodeURIComponent(codeMatch[1]));
      }
      const { data } = await supabase.auth.getSession();
      setSession(data.session);
      setUser(data.session?.user ?? null);
    }
  };

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

    // Handle email confirmation / OAuth deep links that arrive while app is running
    const linkingSub = Linking.addEventListener('url', ({ url }) => {
      void processAuthCallback(url);
    });

    // Handle deep link that launched the app (app was closed when link was tapped)
    Linking.getInitialURL().then((url) => {
      if (url) void processAuthCallback(url);
    });

    return () => {
      subscription.unsubscribe();
      linkingSub.remove();
    };
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
      await processAuthCallback(result.url);
    }
  };

  const signInWithApple = async () => {
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
    if (!credential.identityToken) return;
    const { data, error } = await supabase.auth.signInWithIdToken({
      provider: 'apple',
      token: credential.identityToken,
    });
    if (!error && data.session) {
      setSession(data.session);
      setUser(data.session.user);
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  const deleteAccount = async () => {
    await supabase.rpc('delete_user');
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, signInWithGoogle, signInWithApple, signOut, deleteAccount }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
