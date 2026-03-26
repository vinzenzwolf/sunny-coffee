/**
 * Self-contained WebView HTML page.
 *
 * Shadow rendering (on-device vector layer):
 *   Shadow polygons are computed on-device in JS and pushed to a GeoJSON
 *   source. MapLibre then renders them as a GPU `fill` layer.
 *   → avoids per-frame canvas redraws and keeps rendering on WebGL.
 *
 * Map:      OpenFreeMap liberty (free vector tiles, building heights included)
 * Buildings: map.queryRenderedFeatures() over a padded screen bbox so nearby
 *            off-screen buildings are included for smoother shadow continuity.
 *
 * RN ↔ WebView bridge
 *  RN → WebView  { type:'INIT'|'SET_DATE'|'SET_SHADOWS', ... }
 *  WebView → RN  { type:'MAP_READY'|'STATUS'|'WARNING'|'ERROR', ... }
 */

const MAPLIBRE_VER = '4.7.1';
const SUNCALC_VER  = '1.9.0';
const OFMAP_STYLE  = 'https://tiles.openfreemap.org/styles/liberty';
const BACKEND_URL  = 'https://server.vinzenzwolf.ch';

export const MAP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport"
        content="width=device-width,initial-scale=1.0,
                 maximum-scale=1.0,user-scalable=no">
  <title>Map</title>
  <link rel="stylesheet"
        href="https://unpkg.com/maplibre-gl@${MAPLIBRE_VER}/dist/maplibre-gl.css">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    html, body, #map { width:100%; height:100%; overflow:hidden; }
    .maplibregl-ctrl-bottom-left,
    .maplibregl-ctrl-bottom-right { display:none; }
    #night-overlay {
      position: absolute;
      inset: 0;
      background: #3a3a3a;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.12s linear;
    }
    .cafe-pin {
      display: flex;
      flex-direction: column;
      align-items: center;
      transform: translateY(-6px);
      pointer-events: auto;
      cursor: pointer;
    }
    .cafe-bubble {
      background: #fff;
      border-radius: 16px;
      padding: 5px 10px;
      font-size: 11px;
      font-weight: 600;
      color: #1c1b19;
      box-shadow: 0 3px 12px rgba(0, 0, 0, 0.12);
      display: flex;
      align-items: center;
      gap: 5px;
      white-space: nowrap;
      max-width: 150px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .cafe-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #f5a623;
      box-shadow: 0 0 4px rgba(245, 166, 35, 0.6);
      flex-shrink: 0;
    }
    .cafe-dot.shade {
      background: #63605c;
      box-shadow: 0 0 3px rgba(28, 27, 25, 0.35);
    }
    .cafe-tail {
      width: 2px;
      height: 6px;
      border-radius: 1px;
      background: #1c1b19;
      opacity: 0.2;
      margin-top: 1px;
    }
    .cafe-bubble.sel {
      background: #1c1b19;
      color: #fff;
    }
    .cafe-tail.sel {
      opacity: 1;
    }
    .cafe-dot-pin.sel {
      box-shadow: 0 0 0 3px #1c1b19, 0 1px 4px rgba(0,0,0,0.2);
    }
    .cafe-dot-pin {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #f5a623;
      box-shadow: 0 0 0 2px rgba(255,255,255,0.85), 0 1px 4px rgba(0,0,0,0.2);
    }
    .cafe-dot-pin.shade {
      background: #8a8680;
      box-shadow: 0 0 0 2px rgba(255,255,255,0.85), 0 1px 4px rgba(0,0,0,0.15);
    }

  </style>
</head>
<body>
  <div id="map"></div>
  <div id="night-overlay"></div>

  <script src="https://unpkg.com/maplibre-gl@${MAPLIBRE_VER}/dist/maplibre-gl.js"></script>
  <script src="https://unpkg.com/suncalc@${SUNCALC_VER}/suncalc.js"></script>
  <script src="https://unpkg.com/polygon-clipping@0.15.7/dist/polygon-clipping.umd.min.js"></script>

<script>
(function () {
  'use strict';

  /* ── constants ──────────────────────────────────────────────────────────── */
  var DEFAULT_CENTER  = [12.5683, 55.6761];
  var DEFAULT_ZOOM    = 15;
  var MAX_SHADOW_M    = 400;
  var MIN_SUN_ALT_RAD = 0.017;
  var SHADOW_QUERY_PAD_FACTOR = 1.75; // 1.0 = viewport only, 1.75 = include surroundings
  // Uniform semitransparent shadows require dissolved geometry
  // (otherwise overlap regions get darker due to alpha stacking).
  var SHADOW_OPACITY  = 0.42;
  var SHADOW_COLOR    = '#4f5f7d';
  var SHADOW_SOURCE_ID = 'client-shadows';
  var SHADOW_LAYER_ID  = 'client-shadows-fill';
  var NIGHT_OVERLAY_OPACITY = 0.55;
  var MAX_DISSOLVE_FEATURES = 2000;
  var DISSOLVE_MIN_ZOOM = 16.2;
  var SHADOW_OPACITY_FAST = 0.30;
  var MAX_SHADOW_RING_POINTS = 28;
  var MAX_SHADOW_RING_POINTS_SCRUB = 12;
  var SCRUB_UPDATE_INTERVAL_MS = 70;
  var CAFE_SOURCE_ID = 'osm-cafes';
  var MAX_VISIBLE_CAFE_MARKERS = 140;
  var CAFE_HIDE_ZOOM = 13;
  var CAFE_DOT_ONLY_ZOOM = 16;

  /* ── state ──────────────────────────────────────────────────────────────── */
  var currentDate      = new Date();
  var shadowsEnabled   = true;
  var buildingLayerIds = [];   // filled on 'load' from the style's actual layer IDs
  var mapLoaded        = false;
  var shadowUpdateTimer = null;
  var lastShadowKey = '';
  var shadowUpdateInFlight = false;
  var shadowUpdateQueued = false;
  var isScrubbing = false;
  var selectedCafeId = null;
  var nightOverlay = document.getElementById('night-overlay');
  var cafeFeatures = [];
  var cafeMarkers = [];
  var lastCafeSunById = {};
  // Backend buildings: fetched once, used for all shadow computation
  var backendBuildings = null; // null = not yet loaded, [] = loaded but empty

  /* ── Inline sun position (fallback when SunCalc CDN fails) ─────────────── */
  function calcSunPos(date, latDeg, lonDeg) {
    var rad = Math.PI / 180;
    var d   = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 86400000;
    var L   = (280.460 + 0.9856474 * d) % 360;
    var g   = (357.528 + 0.9856003 * d) * rad;
    var lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
    var eps = 23.439 * rad;
    var sinDec = Math.sin(eps) * Math.sin(lam);
    var dec    = Math.asin(sinDec);
    var cosDec = Math.cos(dec);
    /* Greenwich Mean Sidereal Time (hours) */
    var GMST = (18.697375 + 24.0657098244 * d) % 24;
    var LST  = (GMST + lonDeg / 15) % 24;
    var HA   = (LST - 12) * 15 * rad;
    var latR = latDeg * rad;
    var sinAlt = Math.sin(latR) * sinDec + Math.cos(latR) * cosDec * Math.cos(HA);
    var alt    = Math.asin(sinAlt);
    var cosAz  = (sinDec - Math.sin(latR) * sinAlt) / (Math.cos(latR) * Math.cos(alt));
    cosAz = Math.max(-1, Math.min(1, cosAz));
    var az = Math.acos(cosAz);
    if (Math.sin(HA) > 0) az = 2 * Math.PI - az;
    /* Match SunCalc convention: azimuth is south-based (-π…π) */
    az = az - Math.PI;
    return { altitude: alt, azimuth: az };
  }

  function getSunPos(date, latDeg, lonDeg) {
    if (window.SunCalc) return SunCalc.getPosition(date, latDeg, lonDeg);
    return calcSunPos(date, latDeg, lonDeg);
  }

  /* ── RN bridge ──────────────────────────────────────────────────────────── */
  function postToRN(obj) {
    try {
      if (window.ReactNativeWebView)
        window.ReactNativeWebView.postMessage(JSON.stringify(obj));
    } catch (_) {}
  }

  /* ── Backend buildings: fetch once on load ──────────────────────────────── */
  function fetchBackendBuildings() {
    fetch('${BACKEND_URL}/buildings')
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        var features = [];
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          var coords = Array.isArray(row.coords) ? row.coords : [];
          if (coords.length < 3) continue;
          // Ensure ring is closed
          var ring = coords.map(function(c) { return [c[0], c[1]]; });
          if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
            ring.push(ring[0]);
          }
          features.push({
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: [ring] },
            properties: { height: row.height_m || 10.0 },
          });
        }
        backendBuildings = { type: 'FeatureCollection', features: features };
        postToRN({ type: 'STATUS', buildingCount: features.length, sunAlt: 0, sunAz: 0 });
        if (mapLoaded) scheduleShadowUpdate(0);
      })
      .catch(function (e) {
        postToRN({ type: 'WARNING', message: 'Could not load buildings from backend, using map tiles' });
        backendBuildings = [];  // mark as failed so we fall back
        if (mapLoaded) scheduleShadowUpdate(0);
      });
  }

  function getBuildings() {
    if (backendBuildings && backendBuildings.features && backendBuildings.features.length > 0) {
      var bounds = map.getBounds();
      var padLng = (bounds.getEast() - bounds.getWest()) * 0.75;
      var padLat = (bounds.getNorth() - bounds.getSouth()) * 0.75;
      var minLng = bounds.getWest() - padLng;
      var maxLng = bounds.getEast() + padLng;
      var minLat = bounds.getSouth() - padLat;
      var maxLat = bounds.getNorth() + padLat;
      var filtered = backendBuildings.features.filter(function(f) {
        var coords = f.geometry.coordinates[0];
        return coords.some(function(p) {
          return p[0] >= minLng && p[0] <= maxLng && p[1] >= minLat && p[1] <= maxLat;
        });
      });
      return { type: 'FeatureCollection', features: filtered };
    }
    return queryBuildings();
  }

  /* ── Building data from rendered features (fallback) ────────────────────── */
  function getPaddedQueryBox() {
    var c = map.getContainer();
    var w = c.clientWidth;
    var h = c.clientHeight;
    var padX = ((SHADOW_QUERY_PAD_FACTOR - 1) * w) / 2;
    var padY = ((SHADOW_QUERY_PAD_FACTOR - 1) * h) / 2;
    // Pixel-space query box relative to map container top-left.
    return [[-padX, -padY], [w + padX, h + padY]];
  }

  function queryBuildings() {
    function ringBoundsKey(ring) {
      var minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
      for (var i = 0; i < ring.length; i++) {
        var p = ring[i];
        if (!p || typeof p[0] !== 'number' || typeof p[1] !== 'number') continue;
        if (p[0] < minLon) minLon = p[0];
        if (p[1] < minLat) minLat = p[1];
        if (p[0] > maxLon) maxLon = p[0];
        if (p[1] > maxLat) maxLat = p[1];
      }
      if (!isFinite(minLon) || !isFinite(minLat) || !isFinite(maxLon) || !isFinite(maxLat)) {
        return null;
      }
      return [
        minLon.toFixed(6),
        minLat.toFixed(6),
        maxLon.toFixed(6),
        maxLat.toFixed(6),
        ring.length
      ].join(',');
    }

    var raw;
    try {
      /* Use the layer IDs discovered from the style at load time so we never
         depend on hardcoded names that differ between map styles. */
      var opts = buildingLayerIds.length ? { layers: buildingLayerIds } : {};
      raw = map.queryRenderedFeatures(getPaddedQueryBox(), opts);
      // Some MapLibre builds only return rendered features inside the viewport
      // and may yield an empty result for off-screen query boxes.
      if (!raw.length) {
        raw = map.queryRenderedFeatures(undefined, opts);
      }
      /* If no layer filter was possible, keep only features from source-layer 'building'. */
      if (!buildingLayerIds.length) {
        raw = raw.filter(function (f) { return f.sourceLayer === 'building'; });
      }
    } catch (e) {
      return { type: 'FeatureCollection', features: [] };
    }

    /* Deduplicate and collect features. */
    var seen = {};
    var features = [];

    raw.forEach(function (f) {
      try {
        var geom = f.geometry;
        if (!geom || !geom.coordinates || !geom.coordinates.length) return;

        /* Normalise: for MultiPolygon wrap first polygon so we always handle rings. */
        var rings;
        if (geom.type === 'Polygon') {
          rings = geom.coordinates;
        } else if (geom.type === 'MultiPolygon') {
          rings = geom.coordinates[0];
        } else {
          return;
        }

        var outerRing = rings[0];
        if (!outerRing || !outerRing.length) return;
        var firstPt = outerRing[0];
        if (!firstPt || typeof firstPt[0] !== 'number') return;

        // Primary dedupe key: stable vector-tile feature id across fill/fill-extrusion layers.
        var idKey =
          f.id !== undefined && f.id !== null
            ? String(f.source || '') + ':' + String(f.sourceLayer || '') + ':' + String(f.id)
            : null;
        // Fallback dedupe key for sources without feature ids.
        var geomKey = ringBoundsKey(outerRing);
        var key = idKey || geomKey || (firstPt[0].toFixed(6) + ',' + firstPt[1].toFixed(6));
        if (seen[key]) return;
        seen[key] = true;

        var h = parseFloat((f.properties && f.properties.render_height) || 0) || 10.0;
        features.push({ type: 'Feature', geometry: geom, properties: { height: h } });
      } catch (_) {}
    });

    return { type: 'FeatureCollection', features: features };
  }

  /* ── Geometry: convex hull ──────────────────────────────────────────────── */
  function convexHull(pts) {
    if (pts.length < 3) { var r = pts.slice(); r.push(r[0]); return r; }
    var s = pts.slice().sort(function (a, b) { return a[0]-b[0] || a[1]-b[1]; });
    function cross(O,A,B) { return (A[0]-O[0])*(B[1]-O[1])-(A[1]-O[1])*(B[0]-O[0]); }
    var lo=[], hi=[];
    s.forEach(function(p) {
      while (lo.length>=2 && cross(lo[lo.length-2],lo[lo.length-1],p)<=0) lo.pop();
      lo.push(p);
    });
    for (var i=s.length-1;i>=0;i--) {
      var p=s[i];
      while (hi.length>=2 && cross(hi[hi.length-2],hi[hi.length-1],p)<=0) hi.pop();
      hi.push(p);
    }
    hi.pop(); lo.pop();
    var h = lo.concat(hi);
    if (h.length < 3) return [];
    h.push(h[0]);
    return h;
  }

  function simplifyClosedRing(ring, maxPoints) {
    if (!ring || ring.length < 5) return ring;
    var open = ring.slice(0, -1);
    if (open.length <= maxPoints) return ring;
    var step = Math.ceil(open.length / maxPoints);
    var sampled = [];
    for (var i = 0; i < open.length; i += step) {
      sampled.push(open[i]);
    }
    if (sampled.length < 3) return ring;
    sampled.push(sampled[0]);
    return sampled;
  }

  function emptyShadowCollection() {
    return { type: 'FeatureCollection', features: [] };
  }

  function emptyCafeCollection() {
    return { type: 'FeatureCollection', features: [] };
  }

  function ensureCafeSource() {
    if (!map.getSource(CAFE_SOURCE_ID)) {
      map.addSource(CAFE_SOURCE_ID, {
        type: 'geojson',
        data: emptyCafeCollection(),
      });
    }
  }

  function clearCafeMarkers() {
    for (var i = 0; i < cafeMarkers.length; i++) {
      try { cafeMarkers[i].remove(); } catch (_) {}
    }
    cafeMarkers = [];
  }

  function handleCafeClick(props) {
    selectedCafeId = props.id;
    renderCafeMarkers();
    postToRN({
      type: 'CAFE_SELECTED',
      id: props.id,
      name: props.name,
      lat: props.lat,
      lng: props.lng,
      area: props.area,
      inSunNow: props.inSunNow,
      distanceMeters: props.distanceMeters,
      distanceKm: props.distanceKm,
    });
  }

  function createCafeMarkerElement(props, dotOnly) {
    var name = (props && props.name) || 'Cafe';
    var inSunNow = props && props.inSunNow;
    var isSelected = props && props.id && props.id === selectedCafeId;

    if (dotOnly) {
      var el = document.createElement('div');
      el.className = 'cafe-dot-pin' + (inSunNow === false ? ' shade' : '') + (isSelected ? ' sel' : '');
      var _props = props;
      el.addEventListener('click', function(e) { e.stopPropagation(); handleCafeClick(_props); });
      return el;
    }

    var wrap = document.createElement('div');
    wrap.className = 'cafe-pin';
    var _props = props;
    wrap.addEventListener('click', function(e) { e.stopPropagation(); handleCafeClick(_props); });

    var bubble = document.createElement('div');
    bubble.className = 'cafe-bubble' + (isSelected ? ' sel' : '');

    var dot = document.createElement('span');
    dot.className = 'cafe-dot';
    if (inSunNow === false) {
      dot.className += ' shade';
    }
    bubble.appendChild(dot);
    bubble.appendChild(document.createTextNode(name || 'Cafe'));

    var tail = document.createElement('div');
    tail.className = 'cafe-tail' + (isSelected ? ' sel' : '');

    wrap.appendChild(bubble);
    wrap.appendChild(tail);
    return wrap;
  }

  function renderCafeMarkers() {
    if (!mapLoaded || !cafeFeatures.length) return;
    clearCafeMarkers();
    var zoom = map.getZoom();
    if (zoom < CAFE_HIDE_ZOOM) return;
    var dotOnly = zoom < CAFE_DOT_ONLY_ZOOM;
    var bounds = map.getBounds();
    var visible = 0;

    for (var i = 0; i < cafeFeatures.length; i++) {
      if (visible >= MAX_VISIBLE_CAFE_MARKERS) break;
      var f = cafeFeatures[i];
      var c = f.geometry && f.geometry.coordinates;
      if (!c || c.length < 2) continue;
      if (!bounds.contains([c[0], c[1]])) continue;

      var el = createCafeMarkerElement(f.properties || {}, dotOnly);
      var anchor = dotOnly ? 'center' : 'bottom';
      var marker = new maplibregl.Marker({ element: el, anchor: anchor })
        .setLngLat([c[0], c[1]])
        .addTo(map);
      cafeMarkers.push(marker);
      visible++;
    }
  }

  function setCafeData(cafes) {
    var list = Array.isArray(cafes) ? cafes : [];
    var features = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i] || {};
      if (typeof c.lng !== 'number' || typeof c.lat !== 'number') continue;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
        properties: {
          id: c.id || '',
          name: c.name || 'Cafe',
          area: c.area || '',
          inSunNow: c.metadata && typeof c.metadata.inSunNow === 'boolean'
            ? c.metadata.inSunNow
            : true,
          distanceMeters: c.metadata && typeof c.metadata.distanceMeters === 'number' ? c.metadata.distanceMeters : null,
          distanceKm: c.metadata && typeof c.metadata.distanceKm === 'number' ? c.metadata.distanceKm : null,
          lat: c.lat,
          lng: c.lng,
        },
      });
    }

    cafeFeatures = features;
    var src = map.getSource(CAFE_SOURCE_ID);
    if (src) {
      src.setData({ type: 'FeatureCollection', features: features });
    }
    renderCafeMarkers();
    if (mapLoaded) {
      scheduleShadowUpdate(0);
    }
  }

  function pointInRing(lng, lat, ring) {
    if (!Array.isArray(ring) || ring.length < 3) return false;
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1];
      var xj = ring[j][0], yj = ring[j][1];
      var intersects = ((yi > lat) !== (yj > lat)) &&
        (lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi);
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function pointInPolygonCoords(lng, lat, coords) {
    if (!Array.isArray(coords) || !coords.length) return false;
    if (!pointInRing(lng, lat, coords[0])) return false;
    for (var i = 1; i < coords.length; i++) {
      if (pointInRing(lng, lat, coords[i])) return false;
    }
    return true;
  }

  function isPointInShadow(lng, lat, shadowFC) {
    if (!shadowFC || !Array.isArray(shadowFC.features)) return false;
    for (var i = 0; i < shadowFC.features.length; i++) {
      var geom = shadowFC.features[i] && shadowFC.features[i].geometry;
      if (!geom || !geom.coordinates) continue;
      if (geom.type === 'Polygon') {
        if (pointInPolygonCoords(lng, lat, geom.coordinates)) return true;
      } else if (geom.type === 'MultiPolygon') {
        var polys = geom.coordinates;
        for (var j = 0; j < polys.length; j++) {
          if (pointInPolygonCoords(lng, lat, polys[j])) return true;
        }
      }
    }
    return false;
  }

  function emitCafeSunStatus(shadowFC, sunAltitude) {
    if (!cafeFeatures.length) return;
    var sunAboveHorizon = sunAltitude >= MIN_SUN_ALT_RAD;
    var statuses = [];
    var nextById = {};
    var changed = false;

    for (var i = 0; i < cafeFeatures.length; i++) {
      var f = cafeFeatures[i];
      var c = f.geometry && f.geometry.coordinates;
      var id = f.properties && f.properties.id;
      if (!id || !c || c.length < 2) continue;

      var inSun = sunAboveHorizon && !isPointInShadow(c[0], c[1], shadowFC);
      nextById[id] = inSun;
      statuses.push({ id: id, inSun: inSun });
      if (lastCafeSunById[id] !== inSun) changed = true;
    }

    if (!changed && Object.keys(lastCafeSunById).length === statuses.length) {
      return;
    }
    lastCafeSunById = nextById;
    postToRN({ type: 'CAFE_SUN_STATUS', statuses: statuses });
  }

  function ensureShadowLayer() {
    if (!map.getSource(SHADOW_SOURCE_ID)) {
      map.addSource(SHADOW_SOURCE_ID, {
        type: 'geojson',
        data: emptyShadowCollection(),
      });
    }
    if (!map.getLayer(SHADOW_LAYER_ID)) {
      var beforeLayerId = buildingLayerIds.length ? buildingLayerIds[0] : undefined;
      map.addLayer({
        id: SHADOW_LAYER_ID,
        type: 'fill',
        source: SHADOW_SOURCE_ID,
        paint: {
          'fill-color': SHADOW_COLOR,
          'fill-opacity': shadowsEnabled ? SHADOW_OPACITY : 0,
        },
      }, beforeLayerId);
    }
  }

  function computeShadowGeoJSON(buildings, sun, refLatDeg, options) {
    var opts = options || {};
    var maxPoints = opts.maxPoints || MAX_SHADOW_RING_POINTS;
    var maxFeatures = opts.maxFeatures || Infinity;

    if (!shadowsEnabled || sun.altitude < MIN_SUN_ALT_RAD) return emptyShadowCollection();

    var features = [];
    var spM = Math.min(1 / Math.tan(sun.altitude), MAX_SHADOW_M);
    var northAz = sun.azimuth + Math.PI;
    var sdLonU = -Math.sin(northAz);
    var sdLatU = -Math.cos(northAz);
    var cosLat = Math.max(Math.cos(refLatDeg * Math.PI / 180), 0.01);

    for (var fi = 0; fi < buildings.features.length; fi++) {
      if (features.length >= maxFeatures) break;
      var f = buildings.features[fi];
      var h = (f.properties && f.properties.height) || 10.0;
      var lenM = h * spM;
      var dLon = sdLonU * lenM / (111320 * cosLat);
      var dLat = sdLatU * lenM / 111320;

      var geoRings = f.geometry.type === 'Polygon'
        ? [f.geometry.coordinates[0]]
        : f.geometry.coordinates.map(function (p) { return p[0]; });

      for (var gi = 0; gi < geoRings.length; gi++) {
        if (features.length >= maxFeatures) break;
        var geoRing = geoRings[gi];
        var open = (geoRing[0][0] === geoRing[geoRing.length - 1][0] &&
                    geoRing[0][1] === geoRing[geoRing.length - 1][1])
          ? geoRing.slice(0, -1)
          : geoRing;
        if (open.length < 3) return;

        var proj = open.map(function (p) { return [p[0] + dLon, p[1] + dLat]; });
        var hull = convexHull(open.concat(proj));
        if (hull.length < 4) return;

        var simpleHull = simplifyClosedRing(hull, maxPoints);
        features.push({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [simpleHull] },
          properties: { height: h },
        });
      }
    }

    return { type: 'FeatureCollection', features: features };
  }

  function dissolveShadows(shadowFC) {
    if (!shadowFC.features.length) return shadowFC;
    if (shadowFC.features.length > MAX_DISSOLVE_FEATURES) {
      return shadowFC;
    }
    if (!window.polygonClipping || typeof window.polygonClipping.union !== 'function') {
      return shadowFC;
    }

    function isPos(p) {
      return Array.isArray(p) && p.length >= 2 &&
        typeof p[0] === 'number' && typeof p[1] === 'number';
    }
    function isRing(r) {
      return Array.isArray(r) && r.length >= 4 && isPos(r[0]);
    }
    function isPolygonCoords(c) {
      return Array.isArray(c) && c.length > 0 && isRing(c[0]);
    }
    function isMultiPolygonCoords(c) {
      return Array.isArray(c) && c.length > 0 && isPolygonCoords(c[0]);
    }
    function toMultiPolygonCoords(c) {
      if (isMultiPolygonCoords(c)) return c;
      if (isPolygonCoords(c)) return [c];
      return null;
    }

    try {
      var polys = [];
      for (var i = 0; i < shadowFC.features.length; i++) {
        var coords = shadowFC.features[i].geometry.coordinates;
        var mp = toMultiPolygonCoords(coords);
        if (mp) polys.push(mp);
      }
      if (!polys.length) return emptyShadowCollection();

      // Pairwise reduction is more stable than a long sequential union chain.
      var queue = polys.slice();
      while (queue.length > 1) {
        var next = [];
        for (var j = 0; j < queue.length; j += 2) {
          if (j + 1 < queue.length) {
            next.push(window.polygonClipping.union(queue[j], queue[j + 1]));
          } else {
            next.push(queue[j]);
          }
        }
        queue = next;
      }
      var merged = queue[0];

      var mergedMulti = toMultiPolygonCoords(merged);
      if (!mergedMulti || !mergedMulti.length) return emptyShadowCollection();

      return {
        type: 'FeatureCollection',
        // One dissolved geometry -> one alpha application across the final shadow surface.
        features: [{
          type: 'Feature',
          geometry: { type: 'MultiPolygon', coordinates: mergedMulti },
          properties: {},
        }],
      };
    } catch (_) {
      return shadowFC;
    }
  }

  function updateShadows() {
    if (!mapLoaded) return;
    if (shadowUpdateInFlight) {
      shadowUpdateQueued = true;
      return;
    }
    shadowUpdateInFlight = true;
    try {
      ensureShadowLayer();

      var buildings = getBuildings();
      var center = map.getCenter();
      var sun = getSunPos(currentDate, center.lat, center.lng);
      var zoom = map.getZoom();
      var shadowKey = [
        center.lng.toFixed(4),
        center.lat.toFixed(4),
        zoom.toFixed(2),
        map.getBearing().toFixed(1),
        Math.floor(currentDate.getTime() / 60_000),
        buildings.features.length,
        isScrubbing ? 1 : 0,
        shadowsEnabled ? 1 : 0,
      ].join('|');

      if (shadowKey === lastShadowKey) {
        sendStatus(buildings.features.length);
        return;
      }
      lastShadowKey = shadowKey;

      var rawShadowData = computeShadowGeoJSON(
        buildings,
        sun,
        center.lat,
        isScrubbing
          ? { maxPoints: MAX_SHADOW_RING_POINTS_SCRUB }
          : undefined,
      );
      emitCafeSunStatus(rawShadowData, sun.altitude);
      var src = map.getSource(SHADOW_SOURCE_ID);
      if (src) src.setData(rawShadowData);
      if (nightOverlay) {
        var isNight = sun.altitude < MIN_SUN_ALT_RAD;
        nightOverlay.style.opacity =
          shadowsEnabled && isNight ? String(NIGHT_OVERLAY_OPACITY) : '0';
      }
      if (map.getLayer(SHADOW_LAYER_ID)) {
        map.setPaintProperty(
          SHADOW_LAYER_ID,
          'fill-opacity',
          shadowsEnabled ? SHADOW_OPACITY_FAST : 0
        );
      }

      sendStatus(buildings.features.length);
    } catch (e) {
      postToRN({ type: 'ERROR', message: 'Shadow update failed' });
    } finally {
      shadowUpdateInFlight = false;
      if (shadowUpdateQueued) {
        shadowUpdateQueued = false;
        scheduleShadowUpdate(0);
      }
    }
  }

  function scheduleShadowUpdate(delayMs) {
    if (!mapLoaded) return;
    if (shadowUpdateTimer) clearTimeout(shadowUpdateTimer);
    shadowUpdateTimer = setTimeout(function () {
      shadowUpdateTimer = null;
      updateShadows();
    }, delayMs || 0);
  }

  function sendStatus(buildingCount) {
    var c   = map.getCenter();
    var sun = getSunPos(currentDate, c.lat, c.lng);
    postToRN({
      type:          'STATUS',
      buildingCount: buildingCount || 0,
      sunAlt:        sun.altitude,
      sunAz:         sun.azimuth + Math.PI,
    });
  }

  /* ── MapLibre map ─────────────────────────────────────────────────────────── */

  var map = new maplibregl.Map({
    container:  'map',
    style:      '${OFMAP_STYLE}',
    center:     DEFAULT_CENTER,
    zoom:       DEFAULT_ZOOM,
    interactive: true,
    dragPan:    true,
    dragRotate: true,
    touchZoomRotate: true,
    scrollZoom: true,
    boxZoom: true,
    doubleClickZoom: true,
    keyboard: false,
    pitch:      0,
    maxPitch:   0,
    maxZoom:    18,
    minZoom:    14,
    attributionControl: false,
  });

  map.on('load', function () {
    // Interaction profile: pan + rotate + zoom allowed, pitch disabled.
    try { map.dragPan.enable(); } catch (_) {}
    try { map.keyboard.disable(); } catch (_) {}
    try { map.dragRotate.enable(); } catch (_) {}
    try { map.touchZoomRotate.enable(); map.touchZoomRotate.enableRotation(); } catch (_) {}

    var layers = map.getStyle().layers;

    /* Collect layer IDs whose source-layer is 'building' (fill / fill-extrusion). */
    buildingLayerIds = layers
      .filter(function (l) {
        return l['source-layer'] === 'building' &&
               (l.type === 'fill' || l.type === 'fill-extrusion');
      })
      .map(function (l) { return l.id; });

    // Buildings should be fully opaque.
    buildingLayerIds.forEach(function (id) {
      try {
        var layer = map.getLayer(id);
        if (!layer) return;
        if (layer.type === 'fill-extrusion') {
          map.setPaintProperty(id, 'fill-extrusion-opacity', 1);
        } else if (layer.type === 'fill') {
          map.setPaintProperty(id, 'fill-opacity', 1);
        }
      } catch (_) {}
    });

    /* Strip all symbol layers (labels + POI icons) and shaded-relief raster. */
    var toRemove = layers
      .filter(function (l) {
        return l.type === 'symbol' || l.source === 'ne2_shaded';
      })
      .map(function (l) { return l.id; });
    toRemove.forEach(function (id) {
      try { map.removeLayer(id); } catch (_) {}
    });

    ensureShadowLayer();
    ensureCafeSource();
    if (cafeFeatures.length) {
      var cafeSrc = map.getSource(CAFE_SOURCE_ID);
      if (cafeSrc) {
        cafeSrc.setData({ type: 'FeatureCollection', features: cafeFeatures });
      }
    }

    // User location dot
    map.addSource('user-location', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
      id: 'user-location-dot',
      type: 'circle',
      source: 'user-location',
      paint: {
        'circle-radius': 9,
        'circle-color': '#007AFF',
        'circle-stroke-width': 3,
        'circle-stroke-color': '#fff',
        'circle-stroke-opacity': 1,
      }
    });

    mapLoaded = true;
    renderCafeMarkers();
    // Fetch backend buildings before first shadow update
    fetchBackendBuildings();
    setTimeout(function () { scheduleShadowUpdate(0); }, 250);
    postToRN({ type: 'MAP_READY' });
  });

  map.on('moveend', function () {
    scheduleShadowUpdate(90);
    renderCafeMarkers();
  });

  /* ── Message bridge: RN → WebView ────────────────────────────────────────── */

  function handleMessage(event) {
    if (typeof event.data !== 'string') return;
    try {
      var msg = JSON.parse(event.data);
      switch (msg.type) {

        case 'INIT':
          /* No SDK – client-side shadows are always active. */
          break;

        case 'SET_DATE':
          currentDate = new Date(msg.date);
          scheduleShadowUpdate(isScrubbing ? SCRUB_UPDATE_INTERVAL_MS : 0);
          break;

        case 'SET_CAFES':
          setCafeData(msg.cafes);
          break;

        case 'SET_SHADOWS':
          shadowsEnabled = msg.enabled;
          if (map.getLayer(SHADOW_LAYER_ID)) {
            map.setPaintProperty(
              SHADOW_LAYER_ID,
              'fill-opacity',
              shadowsEnabled ? SHADOW_OPACITY : 0
            );
          }
          scheduleShadowUpdate(0);
          break;

        case 'SCRUB_START':
          isScrubbing = true;
          scheduleShadowUpdate(0);
          break;

        case 'SCRUB_END':
          isScrubbing = false;
          scheduleShadowUpdate(0);
          break;

        case 'CAFE_DESELECTED':
          selectedCafeId = null;
          renderCafeMarkers();
          break;

        case 'SET_LOCATION': {
          var locSrc = map.getSource('user-location');
          if (locSrc && typeof msg.lat === 'number' && typeof msg.lng === 'number') {
            locSrc.setData({
              type: 'FeatureCollection',
              features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [msg.lng, msg.lat] }, properties: {} }]
            });
          }
          break;
        }

        case 'FLY_TO':
          if (typeof msg.lat === 'number' && typeof msg.lng === 'number') {
            map.flyTo({ center: [msg.lng, msg.lat], zoom: 15, duration: 1200 });
          }
          break;

        case 'JUMP_TO':
          if (typeof msg.lat === 'number' && typeof msg.lng === 'number') {
            map.jumpTo({ center: [msg.lng, msg.lat] });
          }
          break;
      }
    } catch (_) {}
  }

  window.addEventListener('message',   handleMessage);
  document.addEventListener('message', handleMessage);

})();
</script>
</body>
</html>`;
