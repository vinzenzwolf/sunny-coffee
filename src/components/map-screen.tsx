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
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
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
import { debounce } from '../utils/debounce';
import { TimeControls } from './time-controls';
import type { ToastMessage } from '../types';

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

function SearchBar({ top, onLocateMe }: { top: number; onLocateMe?: () => void }) {
  return (
    <View style={[styles.searchRow, { top }]}>
      <View style={styles.searchBar}>
        <Ionicons name="search-outline" size={15} color="#C0BCB6" />
        <Text style={styles.searchPlaceholder}>Search cafés…</Text>
      </View>
      <TouchableOpacity style={styles.locBtn} activeOpacity={0.8} onPress={onLocateMe}>
        <Ionicons name="navigate" size={18} color="#1C1B19" />
      </TouchableOpacity>
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

  const [mapReady, setMapReady] = useState(false);
  const [date, setDate] = useState(() => new Date());

  const [buildingCount, setBuildingCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [activeNav, setActiveNav] = useState('map');
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const locationSubRef = useRef<Location.LocationSubscription | null>(null);

  const sendDateToMap = useRef(
    debounce((iso: string) => {
      webviewRef.current?.injectJavaScript(
        buildPostMessage({ type: 'SET_DATE', date: iso }),
      );
    }, 24),
  ).current;

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
      case 'WARNING':
        pushToast('warning', msg.message);
        break;
      case 'ERROR':
        pushToast('error', msg.message);
        break;
    }
  }, []);

  // ─── RN → WebView ─────────────────────────────────────────────────────

  const handleDateChange = useCallback(
    (newDate: Date) => {
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
        onLoadStart={() => setIsLoading(true)}
        onError={(e) => pushToast('error', `WebView: ${e.nativeEvent.description}`)}
      />

      {/* Search bar */}
      <SearchBar top={searchBarTop} onLocateMe={handleLocateMe} />

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
      <TimeControls
        date={date}
        buildingCount={buildingCount}
        isLoading={isLoading || !mapReady}
        bottom={cardBottom}
        onDateChange={handleDateChange}
        onScrubStart={handleScrubStart}
        onScrubEnd={handleScrubEnd}
      />

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
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    zIndex: 15,
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
  searchPlaceholder: {
    flex: 1,
    fontSize: 13,
    color: '#C8C4BF',
    fontWeight: '400',
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
    zIndex: 10,
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
