import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import 'react-native-reanimated';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { Onboarding } from '@/src/components/onboarding';

const ONBOARDING_KEY = 'onboarding_complete';

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();
  // null = not yet checked, false = show onboarding, true = skip
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null);

  useEffect(() => {
    // TODO: remove for production — always show onboarding for testing
    setOnboardingDone(false);
    // AsyncStorage.getItem(ONBOARDING_KEY).then((val: string | null) => {
    //   setOnboardingDone(val === 'true');
    // });
  }, []);

  const handleOnboardingComplete = async () => {
    await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
    setOnboardingDone(true);
  };

  // Wait until we know whether to show onboarding
  if (onboardingDone === null) return null;

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
      </Stack>
      <StatusBar style="dark" />

      {!onboardingDone && (
        <View style={{ position: 'absolute', inset: 0 } as any}>
          <Onboarding onComplete={handleOnboardingComplete} />
        </View>
      )}
    </ThemeProvider>
  );
}
