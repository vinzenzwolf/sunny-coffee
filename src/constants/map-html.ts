/**
 * Self-contained WebView HTML page.
 *
 * Shadow rendering (ShadeMap SDK):
 *   Shadows are rendered by the mapbox-gl-shadow-simulator library (ShadeMap SDK).
 *   It uses ShadeMap's building + terrain data, accessed via an API key that is
 *   passed from RN via the INIT bridge message after MAP_READY.
 *
 * Map:      OpenFreeMap liberty (free vector tiles, building heights included)
 *
 * RN ↔ WebView bridge
 *  RN → WebView  { type:'INIT', shadeMapApiKey } | { type:'SET_DATE'|'SET_SHADOWS', ... }
 *  WebView → RN  { type:'MAP_READY'|'STATUS'|'CAFE_SUN_STATUS'|'WARNING'|'ERROR', ... }
 */

const MAPLIBRE_VER  = '4.7.1';
const SUNCALC_VER   = '1.9.0';
const SHADEMAP_VER  = '0.68.2';
const OFMAP_STYLE   = 'https://tiles.openfreemap.org/styles/liberty';

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
    .cafe-dot-hitbox {
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }
    .cafe-dot-pin.shade {
      background: #8a8680;
      box-shadow: 0 0 0 2px rgba(255,255,255,0.85), 0 1px 4px rgba(0,0,0,0.15);
    }
    .cafe-dot-pin.shade.sel {
      box-shadow: 0 0 0 3px #1c1b19, 0 1px 4px rgba(0,0,0,0.2);
    }

  </style>
</head>
<body>
  <div id="map"></div>
  <div id="night-overlay"></div>

  <script src="https://unpkg.com/maplibre-gl@${MAPLIBRE_VER}/dist/maplibre-gl.js"></script>
  <script src="https://unpkg.com/suncalc@${SUNCALC_VER}/suncalc.js"></script>
  <script src="https://unpkg.com/mapbox-gl-shadow-simulator@${SHADEMAP_VER}/dist/mapbox-gl-shadow-simulator.umd.min.js"></script>

<script>
(function () {
  'use strict';

  /* ── constants ──────────────────────────────────────────────────────────── */
  var DEFAULT_CENTER       = [12.5683, 55.6761];
  var DEFAULT_ZOOM         = 15;
  var MIN_SUN_ALT_RAD      = 0.017;   // ~1°; used for night overlay and sun-above-horizon test
  var NIGHT_OVERLAY_OPACITY = 0.55;
  var SHADEMAP_OPACITY     = 0.65;
  var SHADEMAP_COLOR       = '#333333';
  var CAFE_SOURCE_ID       = 'osm-cafes';
  var MAX_VISIBLE_CAFE_MARKERS = 140;
  var CAFE_HIDE_ZOOM       = 13;
  var CAFE_DOT_ONLY_ZOOM   = 16;

  /* ── state ──────────────────────────────────────────────────────────────── */
  var currentDate    = new Date();
  var shadowsEnabled = true;
  var mapLoaded      = false;
  var isScrubbing    = false;
  var selectedCafeId = null;
  var nightOverlay   = document.getElementById('night-overlay');
  var cafeFeatures   = [];
  var cafeMarkers    = [];
  var lastCafeSunById = {};

  /* ShadeMap SDK state */
  var shadeMap       = null;
  var cafeStatusTimer = null;

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

  /* ── Café rendering helpers ─────────────────────────────────────────────── */

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
      el.className = 'cafe-dot-hitbox';
      var dot = document.createElement('div');
      dot.className = 'cafe-dot-pin' + (inSunNow === false ? ' shade' : '') + (isSelected ? ' sel' : '');
      el.appendChild(dot);
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
          inSunNow: c.metadata && typeof c.metadata.inSunNow === 'boolean'
            ? c.metadata.inSunNow
            : false,
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
      scheduleCafeStatus(100);
    }
  }

  /* ── ShadeMap SDK ───────────────────────────────────────────────────────── */

  function scheduleCafeStatus(delayMs) {
    if (cafeStatusTimer) clearTimeout(cafeStatusTimer);
    cafeStatusTimer = setTimeout(function () {
      cafeStatusTimer = null;
      emitCafeSunStatus();
    }, delayMs || 0);
  }

  function emitCafeSunStatus() {
    if (!cafeFeatures.length || !shadeMap) return;
    var center = map.getCenter();
    var sun = getSunPos(currentDate, center.lat, center.lng);
    var sunAboveHorizon = sun.altitude >= MIN_SUN_ALT_RAD;

    var statuses = [];
    var nextById = {};
    var changed = false;

    for (var i = 0; i < cafeFeatures.length; i++) {
      var f = cafeFeatures[i];
      var c = f.geometry && f.geometry.coordinates;
      var id = f.properties && f.properties.id;
      if (!id || !c || c.length < 2) continue;

      var inSun;
      if (!shadowsEnabled || !sunAboveHorizon) {
        /* Shadows off or nighttime: treat as in-sun when above horizon */
        inSun = sunAboveHorizon;
      } else {
        try {
          var pt = map.project([c[0], c[1]]);
          inSun = shadeMap.isPositionInSun(pt.x, pt.y);
        } catch (_) {
          inSun = sunAboveHorizon;
        }
      }

      nextById[id] = inSun;
      statuses.push({ id: id, inSun: inSun });
      if (lastCafeSunById[id] !== inSun) changed = true;
    }

    if (!changed && Object.keys(lastCafeSunById).length === statuses.length) return;
    lastCafeSunById = nextById;

    /* Update cafeFeatures in-place so renderCafeMarkers reflects new sun/shade state */
    for (var j = 0; j < cafeFeatures.length; j++) {
      var fj = cafeFeatures[j];
      var fid = fj.properties && fj.properties.id;
      if (fid && fid in nextById) fj.properties.inSunNow = nextById[fid];
    }
    renderCafeMarkers();
    postToRN({ type: 'CAFE_SUN_STATUS', statuses: statuses });
  }

  function initShadeMap(apiKey) {
    if (shadeMap) {
      map.off('idle', emitCafeSunStatus);
      try { shadeMap.remove(); } catch (_) {}
      shadeMap = null;
    }

    if (typeof ShadeMap === 'undefined') {
      postToRN({ type: 'ERROR', message: 'ShadeMap SDK failed to load' });
      return;
    }
    if (!apiKey) {
      postToRN({ type: 'WARNING', message: 'ShadeMap API key missing' });
      return;
    }

    try {
      shadeMap = new ShadeMap({
        date:    currentDate,
        color:   SHADEMAP_COLOR,
        opacity: shadowsEnabled ? SHADEMAP_OPACITY : 0,
        apiKey:  apiKey,
        terrainSource: {
          maxZoom: 15,
          tileSize: 256,
          getSourceUrl: function (tile) {
            return 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/'
              + tile.z + '/' + tile.x + '/' + tile.y + '.png';
          },
          getElevation: function (pixel) {
            return (pixel.r * 256 + pixel.g + pixel.b / 256) - 32768;
          },
        },
        getFeatures: async function () {
          var features = [];
          try {
            var style = map.getStyle();
            if (!style || !style.layers) return features;
            var bldIds = style.layers
              .filter(function (l) { return l['source-layer'] === 'building'; })
              .map(function (l) { return l.id; });
            if (!bldIds.length) return features;
            var raw = map.queryRenderedFeatures(undefined, { layers: bldIds });
            var seen = {};
            raw.forEach(function (f) {
              try {
                var geom = f.geometry;
                if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) return;
                var id = String(f.id != null ? f.id : JSON.stringify(geom.coordinates[0] && geom.coordinates[0][0]));
                if (seen[id]) return;
                seen[id] = true;
                var h = parseFloat((f.properties && f.properties.render_height) || 0) || 10.0;
                features.push({ type: 'Feature', geometry: geom, properties: { height: h } });
              } catch (_) {}
            });
          } catch (_) {}
          return features;
        },
      }).addTo(map);

      map.on('idle', emitCafeSunStatus);
    } catch (e) {
      postToRN({ type: 'ERROR', message: '[SM6] ShadeMap init failed: ' + (e && e.message) + ' | ' + (e && e.stack && e.stack.slice(0, 200)) });
    }
  }

  /* ── Status to RN ───────────────────────────────────────────────────────── */

  function sendStatus() {
    var c   = map.getCenter();
    var sun = getSunPos(currentDate, c.lat, c.lng);
    postToRN({
      type:          'STATUS',
      buildingCount: 0,
      sunAlt:        sun.altitude,
      sunAz:         sun.azimuth + Math.PI,
    });
    if (nightOverlay) {
      var isNight = sun.altitude < MIN_SUN_ALT_RAD;
      nightOverlay.style.opacity =
        shadowsEnabled && isNight ? String(NIGHT_OVERLAY_OPACITY) : '0';
    }
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
    maxBounds:  [[12.20, 55.55], [12.85, 55.80]],
    attributionControl: false,
  });

  map.on('load', function () {
    try { map.dragPan.enable(); } catch (_) {}
    try { map.keyboard.disable(); } catch (_) {}
    try { map.dragRotate.enable(); } catch (_) {}
    try { map.touchZoomRotate.enable(); map.touchZoomRotate.enableRotation(); } catch (_) {}

    var layers = map.getStyle().layers;

    /* Keep buildings flat (hide 3D extrusions). ShadeMap computes shadows independently. */
    layers.forEach(function (l) {
      if (l['source-layer'] === 'building') {
        try {
          if (l.type === 'fill-extrusion') {
            map.setPaintProperty(l.id, 'fill-extrusion-opacity', 0.85);
          } else if (l.type === 'fill') {
            map.setPaintProperty(l.id, 'fill-opacity', 1);
          }
        } catch (_) {}
      }
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

    ensureCafeSource();
    if (cafeFeatures.length) {
      var cafeSrc = map.getSource(CAFE_SOURCE_ID);
      if (cafeSrc) {
        cafeSrc.setData({ type: 'FeatureCollection', features: cafeFeatures });
      }
    }

    /* User location dot */
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
    sendStatus();
    postToRN({ type: 'MAP_READY' });
  });

  map.on('moveend', function () {
    renderCafeMarkers();
    scheduleCafeStatus(200);
    sendStatus();
  });

  map.on('zoomend', function () {
    scheduleCafeStatus(200);
  });

  /* ── Message bridge: RN → WebView ────────────────────────────────────────── */

  function handleMessage(event) {
    if (typeof event.data !== 'string') return;
    try {
      var msg = JSON.parse(event.data);
      switch (msg.type) {

        case 'INIT':
          initShadeMap(msg.shadeMapApiKey || '');
          sendStatus();
          break;

        case 'SET_DATE':
          currentDate = new Date(msg.date);
          if (shadeMap) shadeMap.setDate(currentDate);
          sendStatus();
          /* Café status will be triggered by the render event after ShadeMap repaints */
          break;

        case 'SET_CAFES':
          setCafeData(msg.cafes);
          break;

        case 'SET_SHADOWS':
          shadowsEnabled = msg.enabled;
          if (shadeMap) shadeMap.setOpacity(shadowsEnabled ? SHADEMAP_OPACITY : 0);
          sendStatus();
          scheduleCafeStatus(50);
          break;

        case 'SCRUB_START':
          isScrubbing = true;
          break;

        case 'SCRUB_END':
          isScrubbing = false;
          scheduleCafeStatus(200);
          break;

        case 'CAFE_DESELECTED':
          selectedCafeId = null;
          renderCafeMarkers();
          break;

        case 'SELECT_CAFE':
          if (msg && typeof msg.id === 'string' && msg.id.length > 0) {
            selectedCafeId = msg.id;
            renderCafeMarkers();
          }
          if (typeof msg.lat === 'number' && typeof msg.lng === 'number') {
            var targetZoom = typeof msg.zoom === 'number' ? msg.zoom : 16.8;
            map.flyTo({ center: [msg.lng, msg.lat], zoom: targetZoom, duration: 1000 });
          }
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

        case 'CLEAR_LOCATION': {
          var userLocSrc = map.getSource('user-location');
          if (userLocSrc) {
            userLocSrc.setData({
              type: 'FeatureCollection',
              features: []
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
