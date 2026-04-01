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
  GestureResponderEvent,
  LayoutChangeEvent,
  TextInput,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView, { WebViewMessageEvent } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';

import { MAP_HTML } from '../constants/map-html';
import { useCafeData } from '../context/cafe-data-context';
import { useSavedCafes } from '../context/saved-cafes-context';
import { getDaylight } from '../services/sun-position';
import { throttle } from '../utils/debounce';
import ExploreTab from './explore-tab';
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

type NavItem = { key: string; label: string; icon: keyof typeof Ionicons.glyphMap; iconActive: keyof typeof Ionicons.glyphMap };

const NAV_ITEMS: NavItem[] = [
  { key: 'map',     label: 'Map',     icon: 'map-outline',      iconActive: 'map' },
  { key: 'explore', label: 'Explore', icon: 'search-outline',   iconActive: 'search' },
  { key: 'saved',   label: 'Saved',   icon: 'bookmark-outline', iconActive: 'bookmark' },
  { key: 'profile', label: 'Profile', icon: 'person-outline',   iconActive: 'person' },
];

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

function VenueCard({
  cafe,
  date,
  bottom,
  sunriseMinutes,
  sunsetMinutes,
  onDismiss,
  onDateChange,
  onScrubStart,
  onScrubEnd,
}: {
  cafe: Cafe;
  date: Date;
  bottom: number;
  sunriseMinutes: number;
  sunsetMinutes: number;
  onDismiss: () => void;
  onDateChange: (d: Date) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
}) {
  const sliderWidth = useRef(0);
  const scrubMinutesRef = useRef<number | null>(null);
  const lastSliderMinutes = useRef<number | null>(null);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubMinutes, setScrubMinutes] = useState<number | null>(null);

  const range = sunsetMinutes - sunriseMinutes;
  const rawMinutes = isFinite(date.getTime())
    ? date.getHours() * 60 + date.getMinutes()
    : sunriseMinutes;
  const displayedMinutes =
    scrubMinutes ?? Math.min(Math.max(rawMinutes, sunriseMinutes), sunsetMinutes);
  const dayFraction = range > 0 ? (displayedMinutes - sunriseMinutes) / range : 0;
  const timeLabel = (() => {
    const h = Math.floor(displayedMinutes / 60);
    const m = displayedMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  })();

  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    sliderWidth.current = e.nativeEvent.layout.width;
  }, []);

  const handleTouch = useCallback(
    (e: GestureResponderEvent) => {
      if (sliderWidth.current === 0) return;
      const fraction = e.nativeEvent.locationX / sliderWidth.current;
      if (!isFinite(fraction)) return;
      const clamped = Math.min(Math.max(fraction, 0), 1);
      const minutes = Math.round(sunriseMinutes + clamped * range);
      if (!isFinite(minutes)) return;
      if (lastSliderMinutes.current === minutes) return;
      lastSliderMinutes.current = minutes;
      scrubMinutesRef.current = minutes;
      setScrubMinutes(minutes);
      const next = new Date(date);
      next.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
      if (!isFinite(next.getTime())) return;
      onDateChange(next);
    },
    [date, sunriseMinutes, range, onDateChange],
  );

  const inSun = cafe.metadata?.inSunNow;
  const distanceText = (() => {
    const km = cafe.metadata?.distanceKm;
    const m = cafe.metadata?.distanceMeters;
    if (typeof km === 'number') return `${km.toFixed(1)} km away`;
    if (typeof m === 'number') return `${Math.round(m)}m away`;
    return null;
  })();
  const metaParts = [distanceText].filter(Boolean);

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
          {metaParts.length > 0 && (
            <Text style={vcStyles.meta} numberOfLines={1}>{metaParts.join(' · ')}</Text>
          )}
          {inSun !== undefined && (
            <View style={[vcStyles.tag, inSun ? vcStyles.tagSun : vcStyles.tagShade]}>
              <Text style={[vcStyles.tagText, inSun ? vcStyles.tagTextSun : vcStyles.tagTextShade]}>
                {inSun ? '☀ Sunny now' : '☁ In shade'}
              </Text>
            </View>
          )}
        </View>
        <HeartButton cafeId={cafe.id} />
      </View>

      {/* Inset slider */}
      <View style={vcStyles.sliderInset}>
        <View style={vcStyles.sliderHead}>
          <Text style={vcStyles.sliderLabel}>Sun position</Text>
          <View style={vcStyles.sliderVal}>
            <View style={vcStyles.sliderDot} />
            <Text style={vcStyles.sliderTime}>{timeLabel}</Text>
          </View>
        </View>
        <View
          style={vcStyles.sliderArea}
          onLayout={handleLayout}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderTerminationRequest={() => false}
          onResponderGrant={(e) => {
            setIsScrubbing(true);
            onScrubStart?.();
            handleTouch(e);
          }}
          onResponderMove={handleTouch}
          onResponderRelease={() => {
            const m = scrubMinutesRef.current;
            if (m !== null && isFinite(m)) {
              const next = new Date(date);
              next.setHours(Math.floor(m / 60), m % 60, 0, 0);
              if (isFinite(next.getTime())) onDateChange(next);
            }
            scrubMinutesRef.current = null;
            setIsScrubbing(false);
            setScrubMinutes(null);
            lastSliderMinutes.current = null;
            onScrubEnd?.();
          }}
          onResponderTerminate={() => {
            scrubMinutesRef.current = null;
            setIsScrubbing(false);
            setScrubMinutes(null);
            lastSliderMinutes.current = null;
            onScrubEnd?.();
          }}
        >
          <View style={vcStyles.track} pointerEvents="none">
            <View style={[vcStyles.fill, { width: `${dayFraction * 100}%` as `${number}%` }]} />
            <View style={[vcStyles.thumb, isScrubbing && vcStyles.thumbActive, { left: `${dayFraction * 100}%` as `${number}%` }]} />
          </View>
        </View>
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
  tag: {
    alignSelf: 'flex-start',
    borderRadius: 5,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  tagSun: { backgroundColor: '#FEF3E2' },
  tagShade: { backgroundColor: '#F2F0ED' },
  tagText: { fontSize: 10, fontWeight: '500' },
  tagTextSun: { color: '#F5A623' },
  tagTextShade: { color: '#9A9690' },
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
  sliderInset: {
    backgroundColor: '#F8F6F3',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 10,
  },
  sliderHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  sliderLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: '#B0ADA8',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  sliderVal: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  sliderDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#F5A623',
  },
  sliderTime: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1C1B19',
  },
  sliderArea: { paddingBottom: 2 },
  track: {
    height: 4,
    backgroundColor: '#EAE7E3',
    borderRadius: 2,
    overflow: 'visible',
  },
  fill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 2,
    backgroundColor: '#F5A623',
  },
  thumb: {
    position: 'absolute',
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#F5A623',
    borderWidth: 2.5,
    borderColor: '#F8F6F3',
    top: -6,
    marginLeft: -8,
    ...Platform.select({
      ios: { shadowColor: '#F5A623', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.45, shadowRadius: 4 },
      android: { elevation: 3 },
    }),
  },
  thumbActive: { transform: [{ scale: 1.15 }] },
});

function SearchBar({
  top,
  query,
  results,
  onQueryChange,
  onSelectCafe,
  onLocateMe,
}: {
  top: number;
  query: string;
  results: Cafe[];
  onQueryChange: (value: string) => void;
  onSelectCafe: (cafe: Cafe) => void;
  onLocateMe?: () => void;
}) {
  const hasQuery = query.trim().length > 0;
  const showResults = hasQuery && results.length > 0;

  return (
    <View style={[styles.searchRow, { top }]}>
      <View style={styles.searchTopRow}>
        <View style={styles.searchBar}>
          <Ionicons name="search-outline" size={15} color="#C0BCB6" />
          <TextInput
            value={query}
            onChangeText={onQueryChange}
            placeholder="Search cafés…"
            placeholderTextColor="#C8C4BF"
            style={styles.searchInput}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            onSubmitEditing={() => {
              if (results.length > 0) onSelectCafe(results[0]);
            }}
          />
          {hasQuery && (
            <TouchableOpacity
              onPress={() => onQueryChange('')}
              activeOpacity={0.7}
              style={styles.searchClearBtn}
            >
              <Ionicons name="close-circle" size={18} color="#B7B3AE" />
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity style={styles.locBtn} activeOpacity={0.8} onPress={onLocateMe}>
          <Ionicons name="navigate" size={18} color="#1C1B19" />
        </TouchableOpacity>
      </View>
      {showResults && (
        <View style={styles.searchResults}>
          {results.map((cafe) => (
            <TouchableOpacity
              key={cafe.id}
              style={styles.searchResultItem}
              activeOpacity={0.7}
              onPress={() => onSelectCafe(cafe)}
            >
              <Ionicons name="cafe-outline" size={14} color="#9A9690" />
              <View style={styles.searchResultTextWrap}>
                <Text numberOfLines={1} style={styles.searchResultTitle}>{cafe.name || 'Cafe'}</Text>
                <Text numberOfLines={1} style={styles.searchResultSubtitle}>Copenhagen</Text>
              </View>
              <Ionicons name="chevron-forward" size={14} color="#C0BCB8" />
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

function BottomNav({
  activeKey,
  onPress,
  bottom,
}: {
  activeKey: string;
  onPress: (key: string) => void;
  bottom: number;
}) {
  return (
    <View style={[styles.bnav, { bottom }]}>
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
  const webviewRef = useRef<WebView>(null);
  const { cafes, updateSunStatus } = useCafeData();

  const [mapReady, setMapReady] = useState(false);
  const [date, setDate] = useState(() => new Date());
  const [selectedCafe, setSelectedCafe] = useState<Cafe | null>(null);

  const [buildingCount, setBuildingCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [activeNav, setActiveNav] = useState('map');
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);

  const DEFAULT_LAT = 55.6761;
  const DEFAULT_LNG = 12.5683;
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
  const showExplore = activeNav === 'explore';
  const showSaved = activeNav === 'saved';
  const showProfile = activeNav === 'profile';
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

  // Start watching location once map is ready (only if permission was granted)
  useEffect(() => {
    if (!mapReady) return;
    let sub: Location.LocationSubscription | null = null;
    (async () => {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status !== 'granted') return;
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, timeInterval: 5000, distanceInterval: 10 },
        (loc) => {
          const { latitude: lat, longitude: lng } = loc.coords;
          setUserLocation({ lat, lng });
          webviewRef.current?.injectJavaScript(
            buildPostMessage({ type: 'SET_LOCATION', lat, lng }),
          );
        },
      );
      locationSubRef.current = sub;
    })();
    return () => { sub?.remove(); };
  }, [mapReady]);

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
        const apiKey = process.env['EXPO_PUBLIC_SHADEMAP_API_KEY'] ?? '';
        webviewRef.current?.injectJavaScript(
          buildPostMessage({ type: 'INIT', apiKey }),
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
  }, [updateSunStatus]);

  // ─── RN → WebView ─────────────────────────────────────────────────────

  const handleDateChange = useCallback(
    (newDate: Date) => {
      if (!isFinite(newDate.getTime())) return;
      setDate(newDate);
      sendDateToMap(newDate.toISOString());
    },
    [sendDateToMap],
  );

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
    webviewRef.current?.injectJavaScript(
      buildPostMessage({ type: 'FLY_TO', lat: cafe.lat, lng: cafe.lng }),
    );
    setSearchQuery('');
  }, []);

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
        onLoadStart={() => { setIsLoading(true); setMapReady(false); }}
        onError={(e) => pushToast('error', `WebView: ${e.nativeEvent.description}`)}
      />

      {/* Search bar */}
      {!showExplore && !showSaved && !showProfile && (
        <SearchBar
          top={searchBarTop}
          query={searchQuery}
          results={searchResults}
          onQueryChange={setSearchQuery}
          onSelectCafe={handleSelectCafe}
          onLocateMe={handleLocateMe}
        />
      )}

      {showExplore && (
        <ExploreTab
          topInset={insets.top}
          bottomInset={cardBottom}
          cafes={cafes}
        />
      )}

      {showSaved && (
        <SavedTab
          topInset={insets.top}
          bottomInset={cardBottom}
          onBrowse={() => setActiveNav('explore')}
        />
      )}

      {showProfile && (
        <ProfileTab
          topInset={insets.top}
          bottomInset={cardBottom}
        />
      )}

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

      {/* Time / shadow controls */}
      {!showExplore && !showSaved && !showProfile && (
        selectedCafe ? (
          <VenueCard
            cafe={selectedCafe}
            date={date}
            bottom={cardBottom}
            sunriseMinutes={sunriseMinutes}
            sunsetMinutes={sunsetMinutes}
            onDismiss={handleDismissCafe}
            onDateChange={handleDateChange}
            onScrubStart={handleScrubStart}
            onScrubEnd={handleScrubEnd}
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
            onScrubStart={handleScrubStart}
            onScrubEnd={handleScrubEnd}
          />
        )
      )}

      {/* Bottom navigation */}
      <BottomNav
        activeKey={activeNav}
        onPress={setActiveNav}
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
    height: 44,
    backgroundColor: '#fff',
    borderRadius: 40,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 8,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.08,
        shadowRadius: 12,
      },
      android: { elevation: 3 },
    }),
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    color: '#1C1B19',
    fontWeight: '400',
    paddingVertical: 0,
  },
  searchClearBtn: {
    marginLeft: 2,
  },
  locBtn: {
    width: 44,
    height: 44,
    backgroundColor: '#fff',
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.08,
        shadowRadius: 12,
      },
      android: { elevation: 3 },
    }),
  },
  searchResults: {
    marginTop: 8,
    backgroundColor: '#fff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#ECE8E2',
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.1,
        shadowRadius: 10,
      },
      android: { elevation: 5 },
    }),
  },
  searchResultItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ECE8E2',
  },
  searchResultTextWrap: {
    flex: 1,
  },
  searchResultTitle: {
    fontSize: 13,
    color: '#1C1B19',
    fontWeight: '500',
  },
  searchResultSubtitle: {
    marginTop: 1,
    fontSize: 11,
    color: '#9A9690',
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
