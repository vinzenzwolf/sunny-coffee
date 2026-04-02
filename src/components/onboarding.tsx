import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/auth-context';

interface OnboardingProps {
  onComplete: () => void;
}

// 8 ray angles around the sun
const RAY_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];

// ─── Helpers ──────────────────────────────────────────────────────────────

function usePulseAnims(count: number, scale: number, delay: number) {
  const anims = useRef(Array.from({ length: count }, () => new Animated.Value(1))).current;
  useEffect(() => {
    anims.forEach((anim, i) => {
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * delay),
          Animated.timing(anim, { toValue: scale, duration: 1500, useNativeDriver: true }),
          Animated.timing(anim, { toValue: 1, duration: 1500, useNativeDriver: true }),
        ]),
      ).start();
    });
  }, []);
  return anims;
}

// ─── Screen 1: Welcome ────────────────────────────────────────────────────

function WelcomeScreen({ onNext }: { onNext: () => void }) {
  const insets = useSafeAreaInsets();

  const floatY   = useRef(new Animated.Value(0)).current;
  const rayRot   = useRef(new Animated.Value(0)).current;
  const blink    = useRef(new Animated.Value(1)).current;
  const ringAnims = usePulseAnims(3, 1.04, 500);

  useEffect(() => {
    // Floating sun
    Animated.loop(
      Animated.sequence([
        Animated.timing(floatY, { toValue: -8, duration: 2000, useNativeDriver: true }),
        Animated.timing(floatY, { toValue: 0,  duration: 2000, useNativeDriver: true }),
      ]),
    ).start();

    // Spinning rays
    Animated.loop(
      Animated.timing(rayRot, { toValue: 1, duration: 12000, useNativeDriver: true }),
    ).start();

    // Blinking city dot
    Animated.loop(
      Animated.sequence([
        Animated.timing(blink, { toValue: 0.3, duration: 1000, useNativeDriver: true }),
        Animated.timing(blink, { toValue: 1,   duration: 1000, useNativeDriver: true }),
      ]),
    ).start();
  }, []);

  const spin = rayRot.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <View style={[s.screen, { paddingTop: insets.top + 8 }]}>
      {/* Warm glow behind illustration */}
      <View style={s.glow} pointerEvents="none" />

      {/* Sun illustration */}
      <View style={s.sunArea}>
        {/* Pulsing rings */}
        {[280, 210, 148].map((size, i) => (
          <Animated.View
            key={size}
            style={[s.ring, { width: size, height: size, borderRadius: size / 2, transform: [{ scale: ringAnims[i] }] }]}
          />
        ))}

        {/* Floating sun circle */}
        <Animated.View style={{ transform: [{ translateY: floatY }] }}>
          <View style={s.sunCircle}>
            {/* Spinning rays container */}
            <Animated.View
              style={[s.sunRaysContainer, { transform: [{ rotate: spin }] }]}
            >
              {RAY_ANGLES.map((angle) => (
                <View
                  key={angle}
                  style={[
                    s.ray,
                    { transform: [{ rotate: `${angle}deg` }, { translateY: -52 }] },
                  ]}
                />
              ))}
            </Animated.View>
            <Text style={s.coffeeEmoji}>☕</Text>
          </View>
        </Animated.View>
      </View>

      {/* Bottom content */}
      <View style={[s.bottomContent, { paddingBottom: Math.max(insets.bottom + 16, 52) }]}>
        {/* City tag */}
        <View style={s.cityTag}>
          <Animated.View style={[s.cityBlink, { opacity: blink }]} />
          <Text style={s.cityTagText}>Copenhagen</Text>
        </View>

        {/* App name */}
        <Text style={s.appName}>
          {'Sunny\n'}
          <Text style={s.appNameItalic}>Coffee</Text>
        </Text>

        {/* Tagline */}
        <Text style={s.tagline}>
          {'Find the warmest seat in the city.\nReal-time sun for every café.'}
        </Text>

        {/* Progress dots */}
        <View style={s.dots}>
          <View style={[s.dot, s.dotActive]} />
          <View style={s.dot} />
          <View style={s.dot} />
        </View>

        {/* CTA */}
        <TouchableOpacity style={s.btnPrimary} onPress={onNext} activeOpacity={0.85}>
          <Text style={s.btnPrimaryText}>Find my sunny spot</Text>
          <View style={s.btnArrow}>
            <Text style={s.btnArrowText}>→</Text>
          </View>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Screen 2: Location ───────────────────────────────────────────────────

function LocationScreen({ onComplete }: { onComplete: () => void }) {
  const insets = useSafeAreaInsets();
  const ringAnims = usePulseAnims(3, 1.06, 500);

  const handleAllow = async () => {
    await Location.requestForegroundPermissionsAsync();
    onComplete();
  };

  return (
    <View style={[s.screen, { paddingTop: insets.top + 8 }]}>
      {/* Location illustration */}
      <View style={s.illustArea}>
        <View style={s.locRingsWrap}>
          {[200, 148, 96].map((size, i) => (
            <Animated.View
              key={size}
              style={[
                s.locRing,
                { width: size, height: size, borderRadius: size / 2, transform: [{ scale: ringAnims[i] }] },
              ]}
            />
          ))}
          <View style={s.locCenter}>
            <Text style={s.locPin}>📍</Text>
          </View>
        </View>
      </View>

      {/* Bottom content */}
      <View style={[s.bottomContent, { paddingBottom: Math.max(insets.bottom + 16, 52) }]}>
        <Text style={s.permTitle}>
          {'Allow '}
          <Text style={s.permTitleItalic}>location</Text>
          {'\naccess'}
        </Text>

        <Text style={s.permDesc}>
          Sunny Coffee needs your location to show nearby cafés and calculate sun exposure from where you are.
        </Text>

        {/* Progress dots */}
        <View style={s.dots}>
          <View style={s.dot} />
          <View style={[s.dot, s.dotActive]} />
          <View style={s.dot} />
        </View>

        <TouchableOpacity style={s.btnPrimary} onPress={handleAllow} activeOpacity={0.85}>
          <Text style={s.btnPrimaryText}>Allow location</Text>
          <View style={s.btnArrow}>
            <Text style={s.btnArrowText}>→</Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity style={s.btnGhost} onPress={onComplete} activeOpacity={0.75}>
          <Text style={s.btnGhostText}>Not now</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Screen 3: Sign up ───────────────────────────────────────────────────

function SignUpScreen({ onComplete }: { onComplete: () => void }) {
  const insets = useSafeAreaInsets();
  const { signInWithGoogle, signInWithApple } = useAuth();
  const [loading, setLoading] = useState<'google' | 'apple' | null>(null);
  const ringAnims = usePulseAnims(3, 1.05, 500);

  const wrap = async (provider: 'google' | 'apple', fn: () => Promise<void>) => {
    setLoading(provider);
    try { await fn(); } catch { /* dismissed / cancelled */ }
    setLoading(null);
    onComplete();
  };

  return (
    <View style={[s.screen, { paddingTop: insets.top + 8 }]}>
      <View style={s.illustArea}>
        <View style={s.signupRingsWrap}>
          {[200, 148, 96].map((size, i) => (
            <Animated.View
              key={size}
              style={[s.signupRing, { width: size, height: size, borderRadius: size / 2, transform: [{ scale: ringAnims[i] }] }]}
            />
          ))}
          <View style={s.signupCenter}>
            <Text style={s.signupEmoji}>☀️</Text>
          </View>
        </View>
      </View>

      <View style={[s.bottomContent, { paddingBottom: Math.max(insets.bottom + 16, 52) }]}>
        <Text style={s.permTitle}>
          {'Save your\n'}
          <Text style={s.permTitleItalic}>sunny spots</Text>
        </Text>
        <Text style={s.permDesc}>
          Create a free account to save your favourite cafés and access them across devices.
        </Text>

        <View style={s.dots}>
          <View style={s.dot} />
          <View style={s.dot} />
          <View style={[s.dot, s.dotActive]} />
        </View>

        <TouchableOpacity
          style={[s.authBtn, loading && loading !== 'google' && s.authBtnDimmed]}
          onPress={() => wrap('google', signInWithGoogle)}
          activeOpacity={0.85}
          disabled={!!loading}
        >
          {loading === 'google'
            ? <ActivityIndicator color="#1C1B19" />
            : (<><Ionicons name="logo-google" size={18} color="#333" style={s.authBtnIcon} /><Text style={s.authBtnText}>Continue with Google</Text></>)}
        </TouchableOpacity>

        <TouchableOpacity
          style={[s.authBtn, loading && loading !== 'apple' && s.authBtnDimmed]}
          onPress={() => wrap('apple', signInWithApple)}
          activeOpacity={0.85}
          disabled={!!loading}
        >
          {loading === 'apple'
            ? <ActivityIndicator color="#1C1B19" />
            : (<><Ionicons name="logo-apple" size={18} color="#333" style={s.authBtnIcon} /><Text style={s.authBtnText}>Continue with Apple</Text></>)}
        </TouchableOpacity>

        <TouchableOpacity style={s.skipBtn} onPress={onComplete} activeOpacity={0.75}>
          <Text style={s.btnGhostText}>Skip for now</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Onboarding (exported) ────────────────────────────────────────────────

const SCREEN_WIDTH = Dimensions.get('window').width;

export function Onboarding({ onComplete }: OnboardingProps) {
  const [step, setStep] = useState(0);
  const slideX = useRef(new Animated.Value(0)).current;
  const exitFade = useRef(new Animated.Value(1)).current;

  const goNext = () => {
    Animated.timing(slideX, { toValue: -SCREEN_WIDTH, duration: 320, useNativeDriver: true }).start(() => {
      setStep((s) => s + 1);
      slideX.setValue(SCREEN_WIDTH);
      Animated.timing(slideX, { toValue: 0, duration: 320, useNativeDriver: true }).start();
    });
  };

  const handleComplete = () => {
    Animated.timing(exitFade, { toValue: 0, duration: 300, useNativeDriver: true }).start(() => {
      onComplete();
    });
  };

  return (
    <Animated.View style={[StyleSheet.absoluteFill, { opacity: exitFade, backgroundColor: '#F5F3F0' }]}>
      <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ translateX: slideX }] }]}>
        {step === 0 && <WelcomeScreen onNext={goNext} />}
        {step === 1 && <LocationScreen onComplete={goNext} />}
        {step === 2 && <SignUpScreen onComplete={handleComplete} />}
      </Animated.View>
    </Animated.View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────

const SERIF = Platform.OS === 'ios' ? 'Georgia' : 'serif';

const s = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#F5F3F0',
  },

  // Glow (screen 1)
  glow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 380,
    backgroundColor: '#FEF3E2',
    opacity: 0.55,
    // Rounded bottom to approximate radial feel
    borderBottomLeftRadius: 300,
    borderBottomRightRadius: 300,
  },

  // Sun area (flex: 1 space for illustration)
  sunArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Pulsing rings
  ring: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: 'rgba(245,166,35,0.18)',
  },

  // Sun circle
  sunCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: '#F5A623',
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: {
        shadowColor: '#F5A623',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.45,
        shadowRadius: 32,
      },
      android: { elevation: 12 },
    }),
  },

  // Spinning rays container (overlaid on sunCircle)
  sunRaysContainer: {
    position: 'absolute',
    width: 134,
    height: 134,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Individual ray
  ray: {
    position: 'absolute',
    width: 3,
    height: 14,
    borderRadius: 2,
    backgroundColor: 'rgba(245,166,35,0.55)',
    // Centered in container so rotation is around the center
    top: 67 - 7,
    left: 67 - 1.5,
  },

  coffeeEmoji: {
    fontSize: 34,
  },

  // Location illustration (screen 2)
  illustArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  locRingsWrap: {
    width: 200,
    height: 200,
    alignItems: 'center',
    justifyContent: 'center',
  },
  locRing: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: 'rgba(59,130,246,0.18)',
  },
  locCenter: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#3B82F6',
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: {
        shadowColor: '#3B82F6',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.4,
        shadowRadius: 16,
      },
      android: { elevation: 8 },
    }),
  },
  locPin: {
    fontSize: 22,
  },

  // Sign-up illustration (screen 3)
  signupRingsWrap: {
    width: 200,
    height: 200,
    alignItems: 'center',
    justifyContent: 'center',
  },
  signupRing: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: 'rgba(245,166,35,0.2)',
  },
  signupCenter: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#F5A623',
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: {
        shadowColor: '#F5A623',
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.4,
        shadowRadius: 20,
      },
      android: { elevation: 8 },
    }),
  },
  signupEmoji: {
    fontSize: 30,
  },

  // Bottom content shared
  bottomContent: {
    paddingHorizontal: 36,
  },

  // City tag
  cityTag: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    backgroundColor: '#EDEAE6',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 6,
    marginBottom: 18,
  },
  cityBlink: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: '#F5A623',
  },
  cityTagText: {
    fontSize: 11,
    color: '#9A9690',
    fontWeight: '500',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },

  // App name
  appName: {
    fontFamily: SERIF,
    fontSize: 52,
    fontWeight: '300',
    color: '#1C1B19',
    lineHeight: 52,
    letterSpacing: -1,
    marginBottom: 8,
  },
  appNameItalic: {
    fontFamily: SERIF,
    fontStyle: 'italic',
    color: '#F5A623',
  },

  // Tagline
  tagline: {
    fontSize: 15,
    color: '#B8B4AF',
    fontWeight: '300',
    lineHeight: 23,
    marginBottom: 28,
  },

  // Permission title (screen 2)
  permTitle: {
    fontFamily: SERIF,
    fontSize: 38,
    fontWeight: '300',
    color: '#1C1B19',
    lineHeight: 44,
    letterSpacing: -0.4,
    marginBottom: 10,
  },
  permTitleItalic: {
    fontFamily: SERIF,
    fontStyle: 'italic',
    color: '#F5A623',
  },
  permDesc: {
    fontSize: 14,
    color: '#B8B4AF',
    lineHeight: 23,
    marginBottom: 28,
  },

  // Progress dots
  dots: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 24,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#E0DDD9',
  },
  dotActive: {
    width: 20,
    backgroundColor: '#1C1B19',
  },

  // Primary button
  btnPrimary: {
    width: '100%',
    height: 58,
    borderRadius: 16,
    backgroundColor: '#1C1B19',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginBottom: 12,
    ...Platform.select({
      ios: {
        shadowColor: '#1C1B19',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.15,
        shadowRadius: 14,
      },
      android: { elevation: 4 },
    }),
  },
  btnPrimaryText: {
    fontSize: 16,
    fontWeight: '500',
    color: '#fff',
  },
  btnArrow: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#F5A623',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnArrowText: {
    fontSize: 12,
    color: '#fff',
    fontWeight: '600',
  },

  // Auth provider buttons (Google / Apple / Email)
  authBtn: {
    width: '100%',
    height: 52,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#E8E4DF',
    backgroundColor: '#fff',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4 },
      android: { elevation: 1 },
    }),
  },
  authBtnDimmed: {
    opacity: 0.4,
  },
  authBtnIcon: {
    marginRight: 10,
  },
  authBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1C1B19',
  },

  // Skip link
  skipBtn: {
    width: '100%',
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },

  // Ghost button
  btnGhost: {
    width: '100%',
    height: 48,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: '#E0DDD9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnGhostText: {
    fontSize: 14,
    color: '#B8B4AF',
    fontWeight: '400',
  },
});
