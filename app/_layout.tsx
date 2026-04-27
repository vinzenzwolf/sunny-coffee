import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import { useColorScheme, View } from 'react-native';
import 'react-native-reanimated';
import { Onboarding } from '@/src/components/onboarding';
import { AuthProvider } from '@/src/context/auth-context';
import { CafeDataProvider } from '@/src/context/cafe-data-context';
import { LocationSettingsProvider } from '@/src/context/location-settings-context';
import { SavedCafesProvider } from '@/src/context/saved-cafes-context';

const ONBOARDING_KEY = 'onboarding_complete';

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();
  // null = not yet checked, false = show onboarding, true = skip
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(ONBOARDING_KEY).then((val: string | null) => {
      setOnboardingDone(val === 'true');
    });
  }, []);

  const handleOnboardingComplete = async () => {
    await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
    setOnboardingDone(true);
  };

  // Wait until we know whether to show onboarding
  if (onboardingDone === null) return null;

  return (
    <AuthProvider>
      <SavedCafesProvider>
        <LocationSettingsProvider>
          <CafeDataProvider>
            <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
              <Stack>
                <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              </Stack>
              <StatusBar style="dark" />

              {!onboardingDone && (
                <View style={{ position: 'absolute', inset: 0 } as any}>
                  <Onboarding onComplete={handleOnboardingComplete} />
                </View>
              )}
            </ThemeProvider>
          </CafeDataProvider>
        </LocationSettingsProvider>
      </SavedCafesProvider>
    </AuthProvider>
  );
}
