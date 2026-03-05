/**
 * MapScreen
 *
 * Architecture:
 *  ┌────────────────────────────────────┐
 *  │  react-native-webview (full screen) │  ← MapLibre GL JS + ShadeMap SDK
 *  │                                    │
 *  │   ┌──────────────────────────┐    │
 *  │   │  TimeControls (native)   │    │  ← date picker, shadow toggle
 *  │   └──────────────────────────┘    │
 *  │   ┌──────────┐                   │
 *  │   │ Toast    │                   │  ← error/warning overlay
 *  │   └──────────┘                   │
 *  └────────────────────────────────────┘
 *
 * Communication:
 *   RN  → WebView : webviewRef.injectJavaScript(script)
 *   WebView → RN  : onMessage handler (JSON payloads)
 *
 * On mount the screen sends an INIT message with the ShadeMap API key from
 * process.env.EXPO_PUBLIC_SHADEMAP_API_KEY.  If the key is absent the WebView
 * shows a warning toast and the map still works (no shadow overlay).
 */

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

import { MAP_HTML } from '../constants/map-html';
import { getSunPosition, describeSunPosition } from '../services/sun-position';
import { TimeControls } from './time-controls';
import type { ToastMessage } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Inject a fire-and-forget JS snippet into the WebView. */
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
// Types for WebView messages
// ---------------------------------------------------------------------------

type WebViewMessage =
  | { type: 'MAP_READY' }
  | { type: 'STATUS'; buildingCount: number; sunAlt: number; sunAz: number }
  | { type: 'WARNING'; message: string }
  | { type: 'ERROR'; message: string };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MapScreen() {
  const insets = useSafeAreaInsets();
  const webviewRef = useRef<WebView>(null);

  const [mapReady, setMapReady] = useState(false);
  const [date, setDate] = useState(() => new Date());
  const [shadowsEnabled, setShadowsEnabled] = useState(true);
  const [buildingCount, setBuildingCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [sunDescription, setSunDescription] = useState('');
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // Compute sun description on the RN side (for the status strip)
  useEffect(() => {
    // Use a rough center (Copenhagen default; we don't track map center in RN)
    const pos = getSunPosition(date, 55.6761, 12.5683);
    setSunDescription(describeSunPosition(pos));
  }, [date]);

  // ─── WebView → RN message handler ──────────────────────────────────────

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
        // Send INIT with ShadeMap API key
        const apiKey = process.env['EXPO_PUBLIC_SHADEMAP_API_KEY'] ?? '';
        webviewRef.current?.injectJavaScript(
          buildPostMessage({ type: 'INIT', apiKey }),
        );
        break;
      }
      case 'STATUS':
        setBuildingCount(msg.buildingCount ?? 0);
        // Update sun description from map-center coordinates reported by WebView
        if (msg.sunAlt !== undefined) {
          const pos = {
            altitudeRad: msg.sunAlt,
            azimuthRad: msg.sunAz,
            isAboveHorizon: msg.sunAlt > 0.017,
          };
          setSunDescription(describeSunPosition(pos));
        }
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

  // ─── RN → WebView commands ──────────────────────────────────────────────

  const handleDateChange = useCallback(
    (newDate: Date) => {
      setDate(newDate);
      setIsLoading(true);
      webviewRef.current?.injectJavaScript(
        buildPostMessage({ type: 'SET_DATE', date: newDate.toISOString() }),
      );
    },
    [],
  );

  const handleToggleShadows = useCallback(() => {
    setShadowsEnabled((prev) => {
      const next = !prev;
      webviewRef.current?.injectJavaScript(
        buildPostMessage({ type: 'SET_SHADOWS', enabled: next }),
      );
      return next;
    });
  }, []);

  // ─── Toast helpers ───────────────────────────────────────────────────────

  function pushToast(level: ToastMessage['level'], message: string): void {
    const id = uniqueId();
    setToasts((prev) => [...prev.slice(-2), { id, message, level }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4_000);
  }

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" translucent backgroundColor="transparent" />

      {/* Full-screen WebView: MapLibre GL JS + mapbox-gl-shadow-simulator */}
      <WebView
        ref={webviewRef}
        style={styles.webview}
        // baseUrl gives the page a real origin so CDN scripts load without CORS issues
        source={{ html: MAP_HTML, baseUrl: 'https://example.com' }}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        // Allow mixed HTTP/HTTPS content (OSM tiles are plain HTTP in some regions)
        mixedContentMode="always"
        allowsInlineMediaPlayback
        // Disable scroll so the map's touch gestures work cleanly
        scrollEnabled={false}
        bounces={false}
        onMessage={handleMessage}
        onLoadStart={() => setIsLoading(true)}
        onError={(e) => pushToast('error', `WebView: ${e.nativeEvent.description}`)}
      />

      {/* Toast messages (above the controls) */}
      {toasts.length > 0 && (
        <View style={[styles.toastContainer, { top: insets.top + 12 }]}>
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

      {/* Native time / shadow controls overlaid at the bottom */}
      <TimeControls
        date={date}
        shadowsEnabled={shadowsEnabled}
        sunDescription={sunDescription}
        buildingCount={buildingCount}
        isLoading={isLoading || !mapReady}
        onDateChange={handleDateChange}
        onToggleShadows={handleToggleShadows}
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
    backgroundColor: '#f0ebe3',
  },
  webview: {
    flex: 1,
  },
  // Toasts
  toastContainer: {
    position: 'absolute',
    left: 12,
    right: 12,
    gap: 6,
    zIndex: 20,
  },
  toast: {
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 6,
      },
      android: { elevation: 4 },
    }),
  },
  toastWarning: {
    backgroundColor: '#FFF3CD',
    borderLeftWidth: 4,
    borderLeftColor: '#FF8F00',
  },
  toastError: {
    backgroundColor: '#FFEBEE',
    borderLeftWidth: 4,
    borderLeftColor: '#C62828',
  },
  toastText: {
    fontSize: 13,
    color: '#333',
    lineHeight: 18,
  },
});
