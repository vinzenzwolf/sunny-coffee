/**
 * MapScreen
 *
 * Architecture:
 *  ┌────────────────────────────────────┐
 *  │  react-native-webview (full screen) │  ← MapLibre GL JS + ShadeMap SDK
 *  │                                    │
 *  │   ┌──────────────────────────┐    │
 *  │   │  SearchBar (native)      │    │  ← top overlay
 *  │   └──────────────────────────┘    │
 *  │   ┌──────────────────────────┐    │
 *  │   │  TimeControls (native)   │    │  ← date picker, shadow toggle
 *  │   └──────────────────────────┘    │
 *  │   ┌──────────────────────────┐    │
 *  │   │  BottomNav (native)      │    │  ← frosted glass nav bar
 *  │   └──────────────────────────┘    │
 *  │   ┌──────────┐                   │
 *  │   │ Toast    │                   │  ← error/warning overlay
 *  │   └──────────┘                   │
 *  └────────────────────────────────────┘
 *
 * Communication:
 *   RN  → WebView : webviewRef.injectJavaScript(script)
 *   WebView → RN  : onMessage handler (JSON payloads)
 */

import * as Location from 'expo-location';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Keyboard,
  Linking,
  PanResponder,
  ScrollView,
  TextInput,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView, { WebViewMessageEvent } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';

import { MAP_HTML } from '../constants/map-html';
import { useCafeData } from '../context/cafe-data-context';
import { useLocationSettings } from '../context/location-settings-context';
import { useSavedCafes } from '../context/saved-cafes-context';
import { getDaylight } from '../services/sun-position';
import { throttle } from '../utils/debounce';
import { getOpenUntilToday } from '../utils/opening-hours';
import ProfileTab from './profile-tab';
import SavedTab from './saved-tab';
import { TimeControls } from './time-controls';
import type { Cafe, ToastMessage } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPostMessage(payload: object): string {
  return `(function(){
    var msg = ${JSON.stringify(JSON.stringify(payload))};
    // iOS
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
    // Android
    document.dispatchEvent(new MessageEvent('message', { data: msg }));
  })(); true;`;
}

function uniqueId(): string {
  return Math.random().toString(36).slice(2);
}

const CPH_LAT = 55.6761;
const CPH_LNG = 12.5683;
const CPH_RADIUS_KM = 30;

function kmFromCopenhagen(lat: number, lng: number): number {
  const R = 6371;
  const dLat = (lat - CPH_LAT) * (Math.PI / 180);
  const dLng = (lng - CPH_LNG) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(CPH_LAT * (Math.PI / 180)) * Math.cos(lat * (Math.PI / 180)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseHHmmToMinutes(value: string): number | null {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function computeSunSegments(
  sunWindows: { start: string; end: string }[],
  sunriseMinutes: number,
  sunsetMinutes: number,
): { left: `${number}%`; width: `${number}%` }[] {
  const range = sunsetMinutes - sunriseMinutes;
  if (range <= 0) return [];
  return sunWindows
    .map((w) => {
      const start = parseHHmmToMinutes(w.start);
      const end   = parseHHmmToMinutes(w.end);
      if (start === null || end === null || end <= start) return null;
      const cs = Math.max(sunriseMinutes, Math.min(sunsetMinutes, start));
      const ce = Math.max(sunriseMinutes, Math.min(sunsetMinutes, end));
      if (ce <= cs) return null;
      const leftPct  = ((cs - sunriseMinutes) / range) * 100;
      const widthPct = ((ce - cs) / range) * 100;
      return { left: `${leftPct}%` as `${number}%`, width: `${widthPct}%` as `${number}%` };
    })
    .filter((s): s is { left: `${number}%`; width: `${number}%` } => s !== null);
}

function vcChartData(windows: { start: string; end: string }[]) {
  const segments: { left: `${number}%`; width: `${number}%` }[] = [];
  const candidates: { centerPct: number; text: string }[] = [];

  for (const w of windows) {
    const start = parseHHmmToMinutes(w.start);
    const end   = parseHHmmToMinutes(w.end);
    if (start === null || end === null || end <= start) continue;
    const cs = Math.max(VC_CHART_START, Math.min(VC_CHART_END, start));
    const ce = Math.max(VC_CHART_START, Math.min(VC_CHART_END, end));
    if (ce <= cs) continue;
    const leftPct  = ((cs - VC_CHART_START) / VC_CHART_RANGE) * 100;
    const widthPct = ((ce - cs) / VC_CHART_RANGE) * 100;
    segments.push({ left: `${leftPct}%` as `${number}%`, width: `${widthPct}%` as `${number}%` });
    const sh = Math.floor(start / 60), sm = start % 60;
    const eh = Math.floor(end / 60),   em = end % 60;
    candidates.push({
      centerPct: leftPct + widthPct / 2,
      text: `${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}–${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`,
    });
  }

  const labels: { text: string; left: `${number}%` }[] = [];
  let lastRightEdge = -Infinity;
  for (const c of candidates) {
    const rawLeft = c.centerPct - VC_LABEL_WIDTH_PCT / 2;
    const left = Math.max(0, Math.min(100 - VC_LABEL_WIDTH_PCT, rawLeft));
    if (left >= lastRightEdge - 1) {
      labels.push({ text: c.text, left: `${left}%` as `${number}%` });
      lastRightEdge = left + VC_LABEL_WIDTH_PCT;
    }
  }
  return { segments, labels };
}

function minuteStamp(date: Date): number {
  return Math.floor(date.getTime() / 60_000);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WebViewMessage =
  | { type: 'MAP_READY' }
  | { type: 'STATUS'; buildingCount: number; sunAlt: number; sunAz: number }
  | { type: 'CAFE_SUN_STATUS'; statuses: { id: string; inSun: boolean }[] }
  | { type: 'CAFE_SELECTED'; id: string; name: string; lat: number; lng: number; inSunNow?: boolean; distanceMeters?: number; distanceKm?: number }
  | { type: 'WARNING'; message: string }
  | { type: 'ERROR'; message: string };

// ---------------------------------------------------------------------------
// Nav items config
// ---------------------------------------------------------------------------

type NavKey = 'map' | 'saved' | 'profile';
type NavItem = { key: NavKey; label: string; icon: keyof typeof Ionicons.glyphMap; iconActive: keyof typeof Ionicons.glyphMap };

const NAV_ITEMS: NavItem[] = [
  { key: 'map',     label: 'Map',     icon: 'map-outline',      iconActive: 'map' },
  { key: 'saved',   label: 'Saved',   icon: 'bookmark-outline', iconActive: 'bookmark' },
  { key: 'profile', label: 'Profile', icon: 'person-outline',   iconActive: 'person' },
];
const NAV_KEYS: NavKey[] = NAV_ITEMS.map((item) => item.key);
const TAB_ANIMATION_DURATION_MS = 320;
const VC_CHART_START = 6 * 60;
const VC_CHART_END   = 22 * 60;
const VC_CHART_RANGE = VC_CHART_END - VC_CHART_START;
const VC_LABEL_WIDTH_PCT = 19;

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function HeartButton({ cafeId }: { cafeId: string }) {
  const { isSaved, toggle } = useSavedCafes();
  const saved = isSaved(cafeId);
  return (
    <TouchableOpacity
      style={[vcStyles.arrow, saved && vcStyles.arrowSaved]}
      onPress={() => toggle(cafeId)}
      activeOpacity={0.8}
    >
      <Ionicons name={saved ? 'heart' : 'heart-outline'} size={17} color="#fff" />
    </TouchableOpacity>
  );
}

function DirectionsButton({ cafeId, lat, lng }: { cafeId: string; lat: number; lng: number }) {
  const handlePress = async () => {
    const apiKey = process.env.EXPO_PUBLIC_GOOGLE_PLACES_API_KEY;

    if (apiKey && cafeId) {
      try {
        const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(cafeId)}`, {
          headers: {
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': 'googleMapsUri',
          },
        });
        if (res.ok) {
          const data = (await res.json()) as { googleMapsUri?: string };
          if (data.googleMapsUri) {
            await Linking.openURL(data.googleMapsUri);
            return;
          }
        }
      } catch {
        // Fallback below.
      }
    }

    if (cafeId) {
      await Linking.openURL(`https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(cafeId)}`);
      return;
    }
    await Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${lat},${lng}`);
  };
  return (
    <TouchableOpacity style={vcStyles.arrow} onPress={handlePress} activeOpacity={0.8}>
      <Ionicons name="navigate-outline" size={17} color="#fff" />
    </TouchableOpacity>
  );
}

function todayOpenStatus(cafe: Cafe): { label: string; color: string } {
  const result = getOpenUntilToday(cafe.metadata?.openingHours);
  if (result.isOpen) return { label: result.closesAt ? `Open until ${result.closesAt}` : 'Open now', color: '#4A9B6F' };
  if (result.reason === 'closed_today') return { label: 'Closed today', color: '#A39D95' };
  if (result.reason === 'no_data') return { label: 'No opening hours', color: '#C8C4BF' };
  return { label: 'Closed now', color: '#A39D95' };
}

function VenueCard({
  cafe,
  bottom,
  onDismiss,
}: {
  cafe: Cafe;
  bottom: number;
  onDismiss: () => void;
}) {
  const { segments, labels } = useMemo(
    () => vcChartData(cafe.metadata?.sunWindows ?? []),
    [cafe.metadata?.sunWindows],
  );

  const nowMarkerPct: `${number}%` = (() => {
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    const clamped = Math.max(VC_CHART_START, Math.min(VC_CHART_END, mins));
    return `${((clamped - VC_CHART_START) / VC_CHART_RANGE) * 100}%`;
  })();

  const distanceText = (() => {
    const km = cafe.metadata?.distanceKm;
    const m  = cafe.metadata?.distanceMeters;
    if (typeof km === 'number') return `${km.toFixed(1)} km away`;
    if (typeof m  === 'number') return `${Math.round(m)}m away`;
    return null;
  })();

  const openStatus = todayOpenStatus(cafe);

  return (
    <View style={[vcStyles.card, { bottom }]}>
      <TouchableOpacity style={vcStyles.dismiss} onPress={onDismiss} activeOpacity={0.7}>
        <Text style={vcStyles.dismissText}>✕</Text>
      </TouchableOpacity>

      <View style={vcStyles.top}>
        <View style={vcStyles.img}>
          <Text style={vcStyles.imgEmoji}>☕</Text>
        </View>
        <View style={vcStyles.info}>
          <Text style={vcStyles.name} numberOfLines={1}>{cafe.name}</Text>
          <Text style={[vcStyles.openStatus, { color: openStatus.color }]}>{openStatus.label}</Text>
          {distanceText && (
            <Text style={vcStyles.meta} numberOfLines={1}>{distanceText}</Text>
          )}
        </View>
        <View style={vcStyles.buttonRow}>
          <DirectionsButton cafeId={cafe.id} lat={cafe.lat} lng={cafe.lng} />
          <HeartButton cafeId={cafe.id} />
        </View>
      </View>

      {/* Sun window bar */}
      <View style={vcStyles.chartWrap}>
        <View style={vcStyles.chartTrack}>
          {segments.map((seg, idx) => (
            <View key={idx} style={[vcStyles.chartSunSegment, { left: seg.left, width: seg.width }]} />
          ))}
          <View style={[vcStyles.chartNowMarker, { left: nowMarkerPct }]} />
        </View>
        {labels.length > 0 && (
          <View style={vcStyles.chartLabelRow}>
            {labels.map((lbl, idx) => (
              <Text
                key={idx}
                style={[vcStyles.chartWindowLabel, { left: lbl.left, width: `${VC_LABEL_WIDTH_PCT}%` as `${number}%` }]}
                numberOfLines={1}
              >
                {lbl.text}
              </Text>
            ))}
          </View>
        )}
      </View>

    </View>
  );
}

const CARD_SHADOW_VC = Platform.select({
  ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.11, shadowRadius: 28 },
  android: { elevation: 8 },
}) ?? {};

const vcStyles = StyleSheet.create({
  card: {
    position: 'absolute',
    left: 20,
    right: 20,
    backgroundColor: '#fff',
    borderRadius: 18,
    padding: 16,
    ...CARD_SHADOW_VC,
  },
  dismiss: {
    position: 'absolute',
    top: -11,
    right: 16,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#E5E2DE',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  dismissText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#9A9690',
    lineHeight: 22,
  },
  top: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
    marginBottom: 14,
  },
  img: {
    width: 54,
    height: 54,
    borderRadius: 12,
    backgroundColor: '#FEF3E2',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  imgEmoji: { fontSize: 26 },
  info: { flex: 1 },
  name: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1C1B19',
    marginBottom: 3,
  },
  meta: {
    fontSize: 12,
    color: '#B8B4AF',
    marginBottom: 6,
  },
  arrow: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: '#1C1B19',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  arrowSaved: {
    backgroundColor: '#E8391A',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  chartWrap: {
    marginTop: 12,
  },
  chartTrack: {
    position: 'relative',
    height: 18,
    borderRadius: 9,
    backgroundColor: '#ECE8E2',
    overflow: 'hidden',
  },
  chartSunSegment: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    borderRadius: 9,
    backgroundColor: '#F2B24D',
  },
  chartNowMarker: {
    position: 'absolute',
    top: -2,
    bottom: -2,
    width: 2,
    borderRadius: 1,
    backgroundColor: '#2B2723',
    opacity: 0.85,
  },
  chartLabelRow: {
    position: 'relative',
    height: 16,
    marginTop: 4,
  },
  chartWindowLabel: {
    position: 'absolute',
    textAlign: 'center',
    fontSize: 9,
    color: '#C48A2E',
    fontWeight: '500',
    letterSpacing: 0.1,
  },
  openStatus: {
    fontSize: 12,
    fontWeight: '500',
    marginBottom: 2,
  },
});

function SearchBar({
  top,
  query,
  results,
  onQueryChange,
  onSelectCafe,
  onLocateMe,
  canLocate,
}: {
  top: number;
  query: string;
  results: Cafe[];
  onQueryChange: (value: string) => void;
  onSelectCafe: (cafe: Cafe) => void;
  onLocateMe?: () => void;
  canLocate?: boolean;
}) {
  const [isFocused, setIsFocused] = useState(false);
  const { height: windowHeight } = useWindowDimensions();
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const hasQuery = query.trim().length > 0;
  const showResults = hasQuery && results.length > 0;
  const resultsMaxHeight = useMemo(() => {
    const searchTopRowHeight = 48;
    const spacingUnderSearch = 18;
    const keyboardOffset = keyboardHeight > 0 ? keyboardHeight + 8 : 0;
    const available = windowHeight - top - searchTopRowHeight - spacingUnderSearch - keyboardOffset;
    return Math.max(96, Math.min(available, 360));
  }, [keyboardHeight, top, windowHeight]);

  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', (event) => {
      setKeyboardHeight(event.endCoordinates?.height ?? 0);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return (
    <View style={[styles.searchRow, { top }]}>
      <View style={styles.searchTopRow}>
        <View style={[styles.searchBar, isFocused && styles.searchBarFocused]}>
          <Ionicons name="search-outline" size={16} color={isFocused ? '#AE8550' : '#AFA79C'} />
          <TextInput
            value={query}
            onChangeText={onQueryChange}
            placeholder="Search cafés…"
            placeholderTextColor="#C8C4BF"
            style={styles.searchInput}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            onSubmitEditing={() => {
              if (results.length > 0) onSelectCafe(results[0]);
            }}
          />
          {hasQuery && (
            <TouchableOpacity
              onPress={() => {
                onQueryChange('');
                Keyboard.dismiss();
              }}
              activeOpacity={0.7}
              style={styles.searchClearBtn}
            >
              <Ionicons name="close-circle" size={18} color="#B7B3AE" />
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity
          style={[styles.locBtn, !canLocate && styles.locBtnDisabled]}
          activeOpacity={0.8}
          onPress={onLocateMe}
          disabled={!canLocate}
        >
          <Ionicons name="navigate" size={18} color="#1C1B19" />
        </TouchableOpacity>
      </View>
      {showResults && (
        <View style={styles.searchResults}>
          <ScrollView
            style={{ maxHeight: resultsMaxHeight }}
            contentContainerStyle={styles.searchResultsContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={results.length > 4}
            nestedScrollEnabled
          >
            {results.map((cafe) => (
              <TouchableOpacity
                key={cafe.id}
                style={styles.searchResultItem}
                activeOpacity={0.7}
                onPress={() => onSelectCafe(cafe)}
              >
                <View style={styles.searchResultTextWrap}>
                  <Text numberOfLines={1} style={styles.searchResultTitle}>{cafe.name || 'Cafe'}</Text>
                  <Text numberOfLines={1} style={styles.searchResultSubtitle}>
                    {cafe.googleFormattedAddress || 'Copenhagen'}
                  </Text>
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

function BottomNav({
  activeKey,
  onPress,
  onSwipe,
  bottom,
}: {
  activeKey: NavKey;
  onPress: (key: NavKey) => void;
  onSwipe: (direction: 'left' | 'right') => void;
  bottom: number;
}) {
  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_evt, gesture) => (
      Math.abs(gesture.dx) > 12 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.2
    ),
    onPanResponderRelease: (_evt, gesture) => {
      const swipedFarEnough = Math.abs(gesture.dx) > 40;
      const swipedFastEnough = Math.abs(gesture.vx) > 0.2;
      if (!swipedFarEnough && !swipedFastEnough) return;
      if (gesture.dx < 0) onSwipe('left');
      else onSwipe('right');
    },
  }), [onSwipe]);

  return (
    <View style={[styles.bnav, { bottom }]} {...panResponder.panHandlers}>
      <View style={styles.bnavShimmer} />
      {NAV_ITEMS.map((item) => {
        const isActive = item.key === activeKey;
        return (
          <TouchableOpacity
            key={item.key}
            style={styles.navItem}
            onPress={() => onPress(item.key)}
            activeOpacity={0.7}
          >
            <Ionicons
              name={isActive ? item.iconActive : item.icon}
              size={22}
              color={isActive ? '#1C1B19' : '#9A9690'}
            />
            <Text style={[styles.navLabel, isActive && styles.navLabelActive]}>
              {item.label}
            </Text>
            {isActive && <View style={styles.navDot} />}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function MapScreen() {
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const webviewRef = useRef<WebView>(null);
  const { cafes, updateSunStatus } = useCafeData();
  const { useMyLocation, loading: locationSettingsLoading } = useLocationSettings();

  const [mapReady, setMapReady] = useState(false);
  const [date, setDate] = useState(() => new Date());
  const [selectedCafe, setSelectedCafe] = useState<Cafe | null>(null);

  const [buildingCount, setBuildingCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [activeNav, setActiveNav] = useState<NavKey>('map');
  const tabSlideX = useRef(new Animated.Value(0)).current;
  const prevScreenWidthRef = useRef(screenWidth);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const outsideAlertShownRef = useRef(false);

  const DEFAULT_LAT = CPH_LAT;
  const DEFAULT_LNG = CPH_LNG;
  const { sunriseMinutes, sunsetMinutes } = useMemo(() => {
    const lat = userLocation?.lat ?? DEFAULT_LAT;
    const lng = userLocation?.lng ?? DEFAULT_LNG;
    const { sunrise, sunset } = getDaylight(date, lat, lng);
    const toMin = (d: Date) => d.getHours() * 60 + d.getMinutes();
    return {
      sunriseMinutes: sunrise ? toMin(sunrise) : 360,
      sunsetMinutes: sunset ? toMin(sunset) : 1200,
    };
  // recompute only when the calendar date or location changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date.toDateString(), userLocation?.lat, userLocation?.lng]);
  const [searchQuery, setSearchQuery] = useState('');
  const locationSubRef = useRef<Location.LocationSubscription | null>(null);
  const hasInitialCameraFocusRef = useRef(false);
  const trimmedQuery = searchQuery.trim().toLowerCase();
  const searchResults = trimmedQuery
    ? cafes
      .filter((cafe) => {
        const name = (cafe.name || '').toLowerCase();
        return name.includes(trimmedQuery);
      })
      .sort((a, b) => {
        const ad = a.metadata?.distanceMeters ?? Number.POSITIVE_INFINITY;
        const bd = b.metadata?.distanceMeters ?? Number.POSITIVE_INFINITY;
        return ad - bd;
      })
      .slice(0, 8)
    : [];

  const sendDateToMap = useRef(
    throttle((iso: string) => {
      webviewRef.current?.injectJavaScript(
        buildPostMessage({ type: 'SET_DATE', date: iso }),
      );
    }, 16),
  ).current;

  useEffect(() => {
    if (!mapReady) return;
    webviewRef.current?.injectJavaScript(
      buildPostMessage({
        type: 'SET_CAFES',
        cafes: cafes.map((cafe) => ({
          id: cafe.id,
          name: cafe.name,
          lat: cafe.lat,
          lng: cafe.lng,
          metadata: cafe.metadata ?? {},
        })),
      }),
    );
  }, [mapReady, cafes]);

  useEffect(() => {
    return () => {
      sendDateToMap.cancel();
      locationSubRef.current?.remove();
    };
  }, [sendDateToMap]);

  useEffect(() => {
    if (prevScreenWidthRef.current === screenWidth) return;
    prevScreenWidthRef.current = screenWidth;
    const index = NAV_KEYS.indexOf(activeNav);
    tabSlideX.setValue(-index * screenWidth);
  }, [activeNav, screenWidth, tabSlideX]);

  // On startup, focus camera on current user location; fallback to city center if unavailable.
  useEffect(() => {
    if (!mapReady || locationSettingsLoading) return;
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;
    (async () => {
      const focusCenter = (lat: number, lng: number): void => {
        if (cancelled) return;
        webviewRef.current?.injectJavaScript(
          buildPostMessage({ type: 'JUMP_TO', lat, lng }),
        );
        hasInitialCameraFocusRef.current = true;
      };
      const focusUser = (lat: number, lng: number): void => {
        if (cancelled) return;
        setUserLocation({ lat, lng });
        webviewRef.current?.injectJavaScript(
          buildPostMessage({ type: 'SET_LOCATION', lat, lng }),
        );
        webviewRef.current?.injectJavaScript(
          buildPostMessage({ type: 'FLY_TO', lat, lng }),
        );
        hasInitialCameraFocusRef.current = true;
        if (!outsideAlertShownRef.current && kmFromCopenhagen(lat, lng) > CPH_RADIUS_KM) {
          outsideAlertShownRef.current = true;
          Alert.alert(
            'Only available in Copenhagen',
            'Sunny Coffee currently only works in Copenhagen. The map will still show Copenhagen.',
            [{ text: 'Got it' }],
          );
        }
      };

      if (!useMyLocation) {
        setUserLocation(null);
        webviewRef.current?.injectJavaScript(buildPostMessage({ type: 'CLEAR_LOCATION' }));
        if (!hasInitialCameraFocusRef.current) {
          focusCenter(DEFAULT_LAT, DEFAULT_LNG);
        }
        return;
      }

      let { status } = await Location.getForegroundPermissionsAsync();
      if (status !== 'granted') {
        const req = await Location.requestForegroundPermissionsAsync();
        status = req.status;
      }
      if (status !== 'granted') {
        focusCenter(DEFAULT_LAT, DEFAULT_LNG);
        return;
      }

      const lastKnown = await Location.getLastKnownPositionAsync();
      if (lastKnown?.coords) {
        focusUser(lastKnown.coords.latitude, lastKnown.coords.longitude);
      } else {
        try {
          const current = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          if (current?.coords) {
            focusUser(current.coords.latitude, current.coords.longitude);
          } else {
            focusCenter(DEFAULT_LAT, DEFAULT_LNG);
          }
        } catch {
          focusCenter(DEFAULT_LAT, DEFAULT_LNG);
        }
      }

      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, timeInterval: 5000, distanceInterval: 10 },
        (loc) => {
          const { latitude: lat, longitude: lng } = loc.coords;
          if (cancelled) return;
          setUserLocation({ lat, lng });
          webviewRef.current?.injectJavaScript(
            buildPostMessage({ type: 'SET_LOCATION', lat, lng }),
          );
          if (!hasInitialCameraFocusRef.current) {
            webviewRef.current?.injectJavaScript(
              buildPostMessage({ type: 'FLY_TO', lat, lng }),
            );
            hasInitialCameraFocusRef.current = true;
          }
        },
      );
      if (cancelled) {
        sub.remove();
        return;
      }
      locationSubRef.current = sub;
    })();
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [mapReady, locationSettingsLoading, useMyLocation, DEFAULT_LAT, DEFAULT_LNG]);

  // ─── WebView → RN ─────────────────────────────────────────────────────

  const handleMessage = useCallback((event: WebViewMessageEvent) => {
    let msg: WebViewMessage;
    try {
      msg = JSON.parse(event.nativeEvent.data) as WebViewMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'MAP_READY': {
        setMapReady(true);
        setIsLoading(false);
        webviewRef.current?.injectJavaScript(
          buildPostMessage({ type: 'INIT' }),
        );
        break;
      }
      case 'STATUS':
        setBuildingCount(msg.buildingCount ?? 0);
        setIsLoading(false);
        break;
      case 'CAFE_SELECTED': {
        const found = cafes.find((c) => c.id === msg.id) ?? {
          id: msg.id,
          name: msg.name,
          lat: msg.lat,
          lng: msg.lng,
          metadata: {
            inSunNow: msg.inSunNow,
            distanceMeters: msg.distanceMeters ?? undefined,
            distanceKm: msg.distanceKm ?? undefined,
          },
        };
        setSelectedCafe(found);
        break;
      }
      case 'CAFE_SUN_STATUS':
        updateSunStatus(msg.statuses ?? []);
        setSelectedCafe((prev) => {
          if (!prev) return prev;
          const updated = (msg.statuses ?? []).find((s) => s.id === prev.id);
          if (!updated) return prev;
          return { ...prev, metadata: { ...prev.metadata, inSunNow: updated.inSun } };
        });
        break;
      case 'WARNING':
        pushToast('warning', msg.message);
        break;
      case 'ERROR':
        pushToast('error', msg.message);
        break;
    }
  }, [cafes, updateSunStatus]);

  // ─── RN → WebView ─────────────────────────────────────────────────────

  const handleDateChange = useCallback(
    (newDate: Date) => {
      if (!isFinite(newDate.getTime())) return;
      setDate(newDate);
      sendDateToMap(newDate.toISOString());
    },
    [sendDateToMap],
  );

  const handleSetNow = useCallback(() => {
    const now = new Date();
    setDate(now);
    sendDateToMap(now.toISOString());
  }, [sendDateToMap]);

  const isLiveTime = minuteStamp(date) === minuteStamp(new Date());

  const handleScrubStart = useCallback(() => {
    webviewRef.current?.injectJavaScript(
      buildPostMessage({ type: 'SCRUB_START' }),
    );
  }, []);

  const handleLocateMe = useCallback(() => {
    if (!userLocation) return;
    webviewRef.current?.injectJavaScript(
      buildPostMessage({ type: 'FLY_TO', lat: userLocation.lat, lng: userLocation.lng }),
    );
  }, [userLocation]);

  const handleScrubEnd = useCallback(() => {
    webviewRef.current?.injectJavaScript(
      buildPostMessage({ type: 'SCRUB_END' }),
    );
  }, []);

  const handleDismissCafe = useCallback(() => {
    setSelectedCafe(null);
    webviewRef.current?.injectJavaScript(
      buildPostMessage({ type: 'CAFE_DESELECTED' }),
    );
  }, []);

  const handleSelectCafe = useCallback((cafe: Cafe) => {
    Keyboard.dismiss();
    setSelectedCafe(cafe);
    webviewRef.current?.injectJavaScript(
      buildPostMessage({ type: 'SELECT_CAFE', id: cafe.id, lat: cafe.lat, lng: cafe.lng, zoom: 16.8 }),
    );
    setSearchQuery('');
  }, []);

  const animateToTab = useCallback((targetKey: NavKey) => {
    const targetIndex = NAV_KEYS.indexOf(targetKey);
    if (targetIndex < 0) return;
    setActiveNav(targetKey);
    Animated.timing(tabSlideX, {
      toValue: -targetIndex * screenWidth,
      duration: TAB_ANIMATION_DURATION_MS,
      useNativeDriver: true,
    }).start();
  }, [screenWidth, tabSlideX]);

  const handleTabSwipe = useCallback((direction: 'left' | 'right') => {
    const currentIndex = NAV_KEYS.indexOf(activeNav);
    if (currentIndex < 0) return;
    const delta = direction === 'left' ? 1 : -1;
    const nextIndex = Math.max(0, Math.min(NAV_KEYS.length - 1, currentIndex + delta));
    if (nextIndex === currentIndex) return;
    animateToTab(NAV_KEYS[nextIndex]);
  }, [activeNav, animateToTab]);

  // ─── Toasts ───────────────────────────────────────────────────────────

  function pushToast(level: ToastMessage['level'], message: string): void {
    const id = uniqueId();
    setToasts((prev) => [...prev.slice(-2), { id, message, level }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4_000);
  }

  // ─── Layout values ────────────────────────────────────────────────────

  // Search bar sits just below the status bar / dynamic island area
  const searchBarTop = insets.top + 12;
  // Nav bar: 20px from screen edge, matching side margins
  const navBottom = 20;
  // Slider card sits 12px above the top of the nav bar (nav height = 76)
  const cardBottom = navBottom + 76 + 12;

  // ─── Render ───────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" translucent backgroundColor="transparent" />

      {/* Full-screen WebView */}
      <WebView
        ref={webviewRef}
        style={styles.webview}
        source={{ html: MAP_HTML, baseUrl: 'https://example.com' }}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        mixedContentMode="always"
        allowsInlineMediaPlayback
        scrollEnabled={false}
        bounces={false}
        onMessage={handleMessage}
        onLoadStart={() => { setIsLoading(true); setMapReady(false); hasInitialCameraFocusRef.current = false; }}
        onError={(e) => pushToast('error', `WebView: ${e.nativeEvent.description}`)}
      />

      <View style={styles.tabViewport} pointerEvents="box-none">
        <Animated.View
          pointerEvents="box-none"
          style={[
            styles.tabPager,
            {
              width: screenWidth * NAV_KEYS.length,
              transform: [{ translateX: tabSlideX }],
            },
          ]}
        >
          <View style={[styles.tabPage, { width: screenWidth }]} pointerEvents="box-none">
            <SearchBar
              top={searchBarTop}
              query={searchQuery}
              results={searchResults}
              onQueryChange={setSearchQuery}
              onSelectCafe={handleSelectCafe}
              onLocateMe={handleLocateMe}
              canLocate={useMyLocation && !!userLocation}
            />
            {selectedCafe ? (
              <VenueCard
                cafe={selectedCafe}
                bottom={cardBottom}
                onDismiss={handleDismissCafe}
              />
            ) : (
              <TimeControls
                date={date}
                buildingCount={buildingCount}
                isLoading={isLoading || !mapReady}
                bottom={cardBottom}
                sunriseMinutes={sunriseMinutes}
                sunsetMinutes={sunsetMinutes}
                onDateChange={handleDateChange}
                onSetNow={handleSetNow}
                isLive={isLiveTime}
                onScrubStart={handleScrubStart}
                onScrubEnd={handleScrubEnd}
              />
            )}
          </View>

          <View style={[styles.tabPage, { width: screenWidth }]}>
            <SavedTab
              topInset={insets.top}
              bottomInset={cardBottom}
              onBrowse={() => animateToTab('map')}
              onSelectCafe={(cafe) => {
                handleSelectCafe(cafe);
                animateToTab('map');
              }}
            />
          </View>

          <View style={[styles.tabPage, { width: screenWidth }]}>
            <ProfileTab
              topInset={insets.top}
              bottomInset={cardBottom}
            />
          </View>
        </Animated.View>
      </View>

      {/* Toast messages */}
      {toasts.length > 0 && (
        <View style={[styles.toastContainer, { top: searchBarTop + 56 }]}>
          {toasts.map((t) => (
            <TouchableOpacity
              key={t.id}
              style={[styles.toast, t.level === 'error' ? styles.toastError : styles.toastWarning]}
              onPress={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
              activeOpacity={0.8}
            >
              <Text style={styles.toastText}>{t.message}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Bottom navigation */}
      <BottomNav
        activeKey={activeNav}
        onPress={animateToTab}
        onSwipe={handleTabSwipe}
        bottom={navBottom}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#E8E3D8',
  },
  webview: {
    flex: 1,
  },
  tabViewport: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
    zIndex: 12,
  },
  tabPager: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
  },
  tabPage: {
    height: '100%',
  },

  // Search bar
  searchRow: {
    position: 'absolute',
    left: 20,
    right: 20,
    zIndex: 15,
  },
  searchTopRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  searchBar: {
    flex: 1,
    height: 48,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(225,217,206,0.95)',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 15,
    gap: 9,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.08,
        shadowRadius: 14,
      },
      android: { elevation: 5 },
    }),
  },
  searchBarFocused: {
    borderColor: '#D8B07A',
    ...Platform.select({
      ios: {
        shadowColor: '#D0A468',
        shadowOffset: { width: 0, height: 10 },
        shadowOpacity: 0.18,
        shadowRadius: 16,
      },
      android: { elevation: 7 },
    }),
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: '#1C1B19',
    fontWeight: '500',
    paddingVertical: 0,
  },
  searchClearBtn: {
    marginLeft: 1,
  },
  locBtn: {
    width: 48,
    height: 48,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(225,217,206,0.95)',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.08,
        shadowRadius: 14,
      },
      android: { elevation: 5 },
    }),
  },
  locBtnDisabled: {
    opacity: 0.45,
  },
  searchResults: {
    marginTop: 10,
    backgroundColor: 'rgba(255,255,255,0.97)',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#E9E2D8',
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 10 },
        shadowOpacity: 0.12,
        shadowRadius: 18,
      },
      android: { elevation: 7 },
    }),
  },
  searchResultItem: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#EFE8DE',
  },
  searchResultsContent: {
    paddingVertical: 2,
  },
  searchResultTextWrap: {
    flex: 1,
  },
  searchResultTitle: {
    fontSize: 14,
    color: '#1C1B19',
    fontWeight: '600',
  },
  searchResultSubtitle: {
    marginTop: 2,
    fontSize: 12,
    color: '#8D867B',
  },

  // Bottom nav
  bnav: {
    position: 'absolute',
    left: 20,
    right: 20,
    height: 76,
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderRadius: 28,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.45)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingTop: 4,
    zIndex: 30,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.09,
        shadowRadius: 20,
      },
      android: { elevation: 8 },
    }),
  },
  bnavShimmer: {
    position: 'absolute',
    top: 0,
    left: '10%',
    right: '10%',
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.9)',
  },
  navItem: {
    alignItems: 'center',
    gap: 3,
    minWidth: 60,
    position: 'relative',
  },
  navLabel: {
    fontSize: 10,
    fontWeight: '500',
    color: 'rgba(60,60,67,0.6)',
  },
  navLabelActive: {
    fontWeight: '700',
    color: '#1C1B19',
  },
  navDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#F5A623',
  },

  // Toasts
  toastContainer: {
    position: 'absolute',
    left: 20,
    right: 20,
    gap: 6,
    zIndex: 20,
  },
  toast: {
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.12,
        shadowRadius: 8,
      },
      android: { elevation: 4 },
    }),
  },
  toastWarning: {
    backgroundColor: '#FFF8EC',
    borderLeftWidth: 3,
    borderLeftColor: '#F5A623',
  },
  toastError: {
    backgroundColor: '#FFEBEE',
    borderLeftWidth: 3,
    borderLeftColor: '#C62828',
  },
  toastText: {
    fontSize: 13,
    color: '#1C1B19',
    lineHeight: 18,
  },
});
