# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run on device (requires dev build — Expo Go is NOT supported)
npx expo run:ios

# Start bundler only (if already built)
npx expo start

# Lint
npx expo lint

# Rebuild native project after changing app.json or adding native modules
npx expo prebuild --platform ios
```

No test framework is configured.

## Architecture

**sunny-coffee** is a shadow-casting map app for finding sun-exposed cafés in Copenhagen. The stack is Expo SDK ~54 / React Native 0.81.5 with new architecture enabled, expo-router, iOS-first.

### The WebView boundary

The map lives entirely inside a `react-native-webview`. `src/constants/map-html.ts` is a self-contained HTML file (1000+ lines) that runs MapLibre GL JS 4.7.1, SunCalc, and either:

- **ShadeMap API tiles** (default, requires `EXPO_PUBLIC_SHADEMAP_API_KEY`)
- **Client-side shadow polygons** computed from OSM building footprints (fallback)

Everything visual on the map — buildings, shadows, café markers, night overlay — is rendered inside the WebView. React Native renders the UI chrome on top as native overlays.

### RN ↔ WebView bridge

RN → WebView via `webviewRef.injectJavaScript(buildPostMessage({...}))`:
- `{ type: 'INIT', apiKey }` — sent after MAP_READY
- `{ type: 'SET_DATE', date: isoString }` — update shadow time
- `{ type: 'SET_SHADOWS', enabled: boolean }` — toggle shadow visibility

WebView → RN via `window.ReactNativeWebView.postMessage(json)`:
- `{ type: 'MAP_READY' }` — triggers INIT
- `{ type: 'STATUS', buildingCount, sunAlt, sunAz }`
- `{ type: 'CAFE_SELECTED', cafe }` — user tapped a café marker
- `{ type: 'CAFE_SUN_STATUS', statuses[] }` — sun/shade status batch update
- `{ type: 'WARNING' | 'ERROR', message }`

### Data flow for cafés

1. `CafeDataProvider` (`src/context/cafe-data-context.tsx`) fetches cafés from Overpass on mount, caches them in AsyncStorage under `cafes_cache_v1`, and enriches with Haversine distance.
2. The WebView reads the same `cafes_cache_v1` key directly from AsyncStorage to render café markers — it doesn't go through the bridge.
3. When the map computes which cafés are in sun vs. shade, it sends `CAFE_SUN_STATUS` back to RN, which calls `updateSunStatus()` on the context, making the data available to the `ExploreTab`.

### Component layout

```
app/(tabs)/index.tsx
  └── MapScreen (src/components/map-screen.tsx)
        ├── WebView (full-screen map)
        ├── SearchBar (native overlay, top)
        ├── TimeControls (native overlay, bottom) ← time slider driving SET_DATE
        ├── BottomNav (native overlay) ← tabs: Map / Explore / Saved / Profile
        ├── ExploreTab (src/components/explore-tab.tsx) ← café list
        ├── VenueCard ← detail popup with per-café time slider
        └── Toast ← warnings/errors from WebView
```

### Shadow rendering (WebView side)

- Client-side mode: queries Overpass for `way["building"]` within viewport, projects vertices in the sun-azimuth direction by `height / tan(altitude)`, dissolves overlapping polygons, simplifies with Douglas-Peucker.
- API mode: adds a raster tile layer with ShadeMap URL template. No polygon math needed.
- The WebView always uses client-side building outlines for the 3D building layer regardless of shadow mode.

### Key environment variables

| Variable | Purpose |
|---|---|
| `EXPO_PUBLIC_SHADEMAP_API_KEY` | ShadeMap tile API key (get from shademap.app/about) |
| `EXPO_PUBLIC_SHADOW_MODE` | `'api'` (default) or `'client'` |

Copy `.env.example` to `.env` before running.

### Path aliases

`@/*` resolves to the repo root, so `@/src/components/...` and `@/app/...` both work. Defined in `tsconfig.json`.

### Default location

Copenhagen: center `[12.5683, 55.6761]`, zoom 14.
