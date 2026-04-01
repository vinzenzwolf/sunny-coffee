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
  var SHADOW_OPACITY  = 0.65;
  var SHADOW_COLOR    = '#333333';
  var NIGHT_OVERLAY_OPACITY = 0.55;
  var MAX_SHADOW_RING_POINTS = 28;
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
  var lastRawShadowData = { type: 'FeatureCollection', features: [] };
  var cafeFeatures = [];
  var cafeMarkers = [];
  var lastCafeSunById = {};

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

  /* ── Building data from rendered features (instant, same as what's visible) */
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
      var opts = buildingLayerIds.length ? { layers: buildingLayerIds } : {};
      raw = map.queryRenderedFeatures(getPaddedQueryBox(), opts);
      if (!raw.length) {
        raw = map.queryRenderedFeatures(undefined, opts);
      }
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

  /* ── lng/lat → Mercator [0,1]² (MapLibre's coordinate space) ─────────────── */
  function lngLatToMerc(lng, lat) {
    var x = (lng + 180) / 360;
    var r = Math.PI / 180;
    var y = (1 - Math.log(Math.tan(Math.PI / 4 + lat * r / 2)) / Math.PI) / 2;
    return [x, y];
  }

  /* ── WebGL shadow custom layer ───────────────────────────────────────────── */
  // Renders shadow polygons to an offscreen FBO at full opacity (no per-pixel alpha
  // accumulation = uniform shadow regardless of overlap), then composites the FBO
  // onto MapLibre's framebuffer at SHADOW_OPACITY. Inserted before building layers
  // so buildings and café markers always render on top.
  function createShadowLayer() {
    var gl, shadowProg, quadProg, shadowVBuf, quadVBuf;
    var fbo = null, fboTex = null, fboW = 0, fboH = 0;

    function compileShader(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    }
    function createProg(vs, fs) {
      var p = gl.createProgram();
      gl.attachShader(p, compileShader(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, compileShader(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      return p;
    }

    // Shadow polygon shader: projects Mercator coords via MapLibre's matrix.
    var SHADOW_VS = 'attribute vec2 a_pos;uniform mat4 u_matrix;void main(){gl_Position=u_matrix*vec4(a_pos,0.0,1.0);}';
    var SHADOW_FS = 'void main(){gl_FragColor=vec4(0.200,0.200,0.200,1.0);}'; // #333333

    // Full-screen quad shader: composites the FBO texture with desired opacity.
    var QUAD_VS = 'attribute vec2 a_pos;varying vec2 v_t;void main(){v_t=a_pos*0.5+0.5;gl_Position=vec4(a_pos,0.0,1.0);}';
    var QUAD_FS = 'precision mediump float;uniform sampler2D u_tex;uniform float u_opacity;varying vec2 v_t;void main(){vec4 c=texture2D(u_tex,v_t);gl_FragColor=vec4(c.rgb,c.a*u_opacity);}';

    function ensureFBO(w, h) {
      if (fboTex && fboW === w && fboH === h) return;
      if (fboTex) { gl.deleteTexture(fboTex); gl.deleteFramebuffer(fbo); }
      fboTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, fboTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
      fboW = w; fboH = h;
    }

    return {
      id: 'client-shadows',
      type: 'custom',

      onAdd: function(m, glCtx) {
        gl = glCtx;
        shadowProg = createProg(SHADOW_VS, SHADOW_FS);
        quadProg   = createProg(QUAD_VS,   QUAD_FS);
        shadowVBuf = gl.createBuffer();
        quadVBuf   = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quadVBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
      },

      render: function(glCtx, matrix) {
        if (!shadowsEnabled || !lastRawShadowData.features.length) return;

        // Build triangle list via fan triangulation (polygons are convex hulls).
        var verts = [];
        var features = lastRawShadowData.features;
        for (var fi = 0; fi < features.length; fi++) {
          var geom = features[fi].geometry;
          var polyList = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
          for (var pi = 0; pi < polyList.length; pi++) {
            var ring = polyList[pi][0];
            if (!ring || ring.length < 3) continue;
            var m0 = lngLatToMerc(ring[0][0], ring[0][1]);
            for (var ci = 1; ci + 1 < ring.length; ci++) {
              var ma = lngLatToMerc(ring[ci][0],   ring[ci][1]);
              var mb = lngLatToMerc(ring[ci+1][0], ring[ci+1][1]);
              verts.push(m0[0],m0[1], ma[0],ma[1], mb[0],mb[1]);
            }
          }
        }
        if (!verts.length) return;

        var canvas = map.getCanvas();
        var w = canvas.width, h = canvas.height;
        ensureFBO(w, h);

        // Save MapLibre's current framebuffer so we can restore it for pass 2.
        var prevFBO = gl.getParameter(gl.FRAMEBUFFER_BINDING);

        // PASS 1 — draw all shadow polygons into FBO with blending OFF.
        // Each pixel is written at most once → no alpha stacking.
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.disable(gl.BLEND);
        gl.disable(gl.STENCIL_TEST);

        gl.useProgram(shadowProg);
        gl.uniformMatrix4fv(gl.getUniformLocation(shadowProg, 'u_matrix'), false, matrix);
        gl.bindBuffer(gl.ARRAY_BUFFER, shadowVBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
        var aPos = gl.getAttribLocation(shadowProg, 'a_pos');
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, verts.length / 2);

        // PASS 2 — composite FBO over MapLibre's framebuffer at SHADOW_OPACITY.
        gl.bindFramebuffer(gl.FRAMEBUFFER, prevFBO);
        gl.viewport(0, 0, w, h);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        gl.useProgram(quadProg);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, fboTex);
        gl.uniform1i(gl.getUniformLocation(quadProg, 'u_tex'), 0);
        gl.uniform1f(gl.getUniformLocation(quadProg, 'u_opacity'), SHADOW_OPACITY);
        gl.bindBuffer(gl.ARRAY_BUFFER, quadVBuf);
        var qPos = gl.getAttribLocation(quadProg, 'a_pos');
        gl.enableVertexAttribArray(qPos);
        gl.vertexAttribPointer(qPos, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      },

      onRemove: function(m, glCtx) {
        if (fboTex)    glCtx.deleteTexture(fboTex);
        if (fbo)       glCtx.deleteFramebuffer(fbo);
        if (shadowVBuf) glCtx.deleteBuffer(shadowVBuf);
        if (quadVBuf)   glCtx.deleteBuffer(quadVBuf);
      },
    };
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
        if (open.length < 3) continue;

        var proj = open.map(function (p) { return [p[0] + dLon, p[1] + dLat]; });
        var hull = convexHull(open.concat(proj));
        if (hull.length < 4) continue;

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

  function updateShadows() {
    if (!mapLoaded) return;
    if (shadowUpdateInFlight) {
      shadowUpdateQueued = true;
      return;
    }
    shadowUpdateInFlight = true;
    try {
      var buildings = queryBuildings();
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
        shadowsEnabled ? 1 : 0,
      ].join('|');

      if (shadowKey === lastShadowKey) {
        sendStatus(buildings.features.length);
        return;
      }
      lastShadowKey = shadowKey;

      var rawShadowData = computeShadowGeoJSON(buildings, sun, center.lat);
      emitCafeSunStatus(rawShadowData, sun.altitude);
      lastRawShadowData = rawShadowData;
      map.triggerRepaint();
      if (nightOverlay) {
        var isNight = sun.altitude < MIN_SUN_ALT_RAD;
        nightOverlay.style.opacity =
          shadowsEnabled && isNight ? String(NIGHT_OVERLAY_OPACITY) : '0';
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


    // Buildings: flat 2D fill only — disable fill-extrusion (3D effect), keep flat fill layers.
    buildingLayerIds.forEach(function (id) {
      try {
        var layer = map.getLayer(id);
        if (!layer) return;
        if (layer.type === 'fill-extrusion') {
          map.setPaintProperty(id, 'fill-extrusion-opacity', 0);
        } else if (layer.type === 'fill') {
          map.setPaintProperty(id, 'fill-opacity', 1);
        }
        // Lower minzoom so buildings are queryable at all zoom levels the app allows
        map.setLayerZoomRange(id, 14, 24);
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

    // Insert shadow custom layer before the first building layer so buildings render on top.
    var shadowBeforeId = buildingLayerIds.length ? buildingLayerIds[0] : undefined;
    map.addLayer(createShadowLayer(), shadowBeforeId);
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
    setTimeout(function () { scheduleShadowUpdate(0); }, 250);
    postToRN({ type: 'MAP_READY' });
  });

  map.on('moveend', function () {
    scheduleShadowUpdate(90);
    renderCafeMarkers();
  });

  map.on('zoomend', function () {
    scheduleShadowUpdate(90);
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
          map.triggerRepaint();
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
