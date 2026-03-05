/**
 * Self-contained WebView HTML page.
 *
 * Shadow rendering (client-side canvas):
 *   All shadow polygons are drawn as solid opaque fills onto a transparent
 *   <canvas> overlay, then CSS `opacity` is applied to the WHOLE canvas.
 *   → overlapping shadows never accumulate; the entire canvas is blended once.
 *
 * Map:      OpenFreeMap liberty (free vector tiles, building heights included)
 * Buildings: map.queryRenderedFeatures() – same geometry the user sees, instant
 *
 * RN ↔ WebView bridge
 *  RN → WebView  { type:'INIT'|'SET_DATE'|'SET_SHADOWS', ... }
 *  WebView → RN  { type:'MAP_READY'|'STATUS'|'WARNING'|'ERROR', ... }
 */

const MAPLIBRE_VER = '4.7.1';
const SUNCALC_VER  = '1.9.0';
const OFMAP_STYLE  = 'https://tiles.openfreemap.org/styles/liberty';

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

    /*
     * Shadow canvas overlay.
     * CSS opacity is applied to the ENTIRE canvas as one compositing step,
     * so pixels covered by multiple overlapping shadow polygons are NOT darker
     * – they are still just opaque black on the canvas, blended once at 0.38.
     */
    #shadow-canvas {
      position: absolute;
      top: 0; left: 0;
      pointer-events: none;
      opacity: 0.38;
      transition: opacity 0.2s ease;
    }
  </style>
</head>
<body>
  <div id="map"></div>
  <!-- Shadow overlay: drawn as solid black then composited at CSS opacity -->
  <canvas id="shadow-canvas"></canvas>

  <script src="https://unpkg.com/maplibre-gl@${MAPLIBRE_VER}/dist/maplibre-gl.js"></script>
  <script src="https://unpkg.com/suncalc@${SUNCALC_VER}/suncalc.js"></script>

<script>
(function () {
  'use strict';

  /* ── constants ──────────────────────────────────────────────────────────── */
  var DEFAULT_CENTER  = [12.5683, 55.6761];
  var DEFAULT_ZOOM    = 15;
  var MAX_SHADOW_M    = 400;
  var SHADOW_OPACITY  = 0.38;

  /* ── state ──────────────────────────────────────────────────────────────── */
  var currentDate      = new Date();
  var shadowsEnabled   = true;
  var rafPending       = false;
  var buildingLayerIds = [];   // filled on 'load' from the style's actual layer IDs
  var mapLoaded        = false;
  var cachedBuildings  = [];   // refreshed on idle, reused every render frame

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

  /* ── canvas overlay elements ────────────────────────────────────────────── */
  var shadowCanvas = document.getElementById('shadow-canvas');
  var ctx          = shadowCanvas.getContext('2d');

  /** Resize the canvas to match the map container (CSS pixel dimensions). */
  function syncCanvasSize() {
    var c = map.getContainer();
    var w = c.clientWidth;
    var h = c.clientHeight;
    if (shadowCanvas.width !== w || shadowCanvas.height !== h) {
      shadowCanvas.width  = w;
      shadowCanvas.height = h;
      shadowCanvas.style.width  = w + 'px';
      shadowCanvas.style.height = h + 'px';
    }
  }

  /* ── RN bridge ──────────────────────────────────────────────────────────── */
  function postToRN(obj) {
    try {
      if (window.ReactNativeWebView)
        window.ReactNativeWebView.postMessage(JSON.stringify(obj));
    } catch (_) {}
  }

  /* ── Building data from rendered features (instant, same as what's visible) */
  function queryBuildings() {
    var raw;
    try {
      /* Use the layer IDs discovered from the style at load time so we never
         depend on hardcoded names that differ between map styles. */
      var opts = buildingLayerIds.length ? { layers: buildingLayerIds } : {};
      raw = map.queryRenderedFeatures(undefined, opts);
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

        var key = firstPt[0].toFixed(6) + ',' + firstPt[1].toFixed(6);
        if (seen[key]) return;
        seen[key] = true;

        var h = parseFloat((f.properties && f.properties.render_height) || 0) || 9.0;
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

  /* ── Canvas shadow rendering ─────────────────────────────────────────────── */

  /**
   * Redraws the shadow canvas for the current viewport, date, and buildings.
   *
   * Key design: all shadow polygons are filled as SOLID opaque paths on the
   * canvas.  CSS opacity:0.38 on the canvas element composites the result
   * once.  Overlapping areas (same solid black on canvas) never become darker.
   */
  function drawClientShadows() {
    syncCanvasSize();
    ctx.clearRect(0, 0, shadowCanvas.width, shadowCanvas.height);

    var buildings = queryBuildings();
    sendStatus(buildings.features.length);

    if (!shadowsEnabled) return;

    var center = map.getCenter();
    var sun = getSunPos(currentDate, center.lat, center.lng);
    if (sun.altitude < 0.017) return;   // sun below horizon

    var spM    = Math.min(1 / Math.tan(sun.altitude), MAX_SHADOW_M);
    var northAz = sun.azimuth + Math.PI;
    var sdLonU  = -Math.sin(northAz);
    var sdLatU  = -Math.cos(northAz);
    var cosLat  = Math.cos(center.lat * Math.PI / 180);

    ctx.fillStyle = '#01112f';    // matches ShadeMap SDK default color
    ctx.beginPath();              // single path for ALL shadows → one fill call

    buildings.features.forEach(function (f) {
      var h    = (f.properties && f.properties.height) || 9.0;
      var lenM = h * spM;
      var dLon = sdLonU * lenM / (111320 * cosLat);
      var dLat = sdLatU * lenM / 111320;

      var geoRings = f.geometry.type === 'Polygon'
        ? [f.geometry.coordinates[0]]
        : f.geometry.coordinates.map(function (p) { return p[0]; });

      geoRings.forEach(function (geoRing) {
        var open = (geoRing[0][0] === geoRing[geoRing.length-1][0] &&
                    geoRing[0][1] === geoRing[geoRing.length-1][1])
          ? geoRing.slice(0, -1) : geoRing;
        if (open.length < 3) return;

        var proj = open.map(function (p) { return [p[0]+dLon, p[1]+dLat]; });
        var hull = convexHull(open.concat(proj));
        if (hull.length < 4) return;

        /*
         * Add the shadow polygon as a sub-path. Using ctx.fill() with the
         * 'evenodd' fill rule later ensures that any area inside an even
         * number of sub-paths is NOT filled – but since our sub-paths don't
         * overlap in most cases, 'nonzero' (default) is fine and fills all.
         * The key is that ALL paths are filled in a SINGLE ctx.fill() call,
         * so the 2D canvas compositing model fills each pixel AT MOST once
         * before the CSS opacity is applied.
         */
        var pt0 = map.project(hull[0]);
        ctx.moveTo(pt0.x, pt0.y);
        for (var i = 1; i < hull.length - 1; i++) {
          var pt = map.project(hull[i]);
          ctx.lineTo(pt.x, pt.y);
        }
        ctx.closePath();
      });
    });

    ctx.fill();   // one composite fill call → no per-polygon alpha accumulation
  }

  /** Schedule a shadow redraw on the next animation frame (throttles rapid events). */
  function scheduleDraw() {
    if (!mapLoaded || rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      drawClientShadows();
    });
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
    maxZoom:    18,
    minZoom:    10,
    attributionControl: false,
  });

  map.on('load', function () {
    var layers = map.getStyle().layers;

    /* Collect layer IDs whose source-layer is 'building' (fill / fill-extrusion). */
    buildingLayerIds = layers
      .filter(function (l) {
        return l['source-layer'] === 'building' &&
               (l.type === 'fill' || l.type === 'fill-extrusion');
      })
      .map(function (l) { return l.id; });

    /* Strip all symbol layers (labels + POI icons) and shaded-relief raster. */
    var toRemove = layers
      .filter(function (l) {
        return l.type === 'symbol' || l.source === 'ne2_shaded';
      })
      .map(function (l) { return l.id; });
    toRemove.forEach(function (id) {
      try { map.removeLayer(id); } catch (_) {}
    });

    mapLoaded = true;
    setTimeout(scheduleDraw, 500);   // initial draw once tiles have had time to load
    postToRN({ type: 'MAP_READY' });
  });

  /* scheduleDraw is rAF-throttled – safe to call on every render frame. */
  map.on('render', scheduleDraw);

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
          scheduleDraw();
          break;

        case 'SET_SHADOWS':
          shadowsEnabled = msg.enabled;
          shadowCanvas.style.opacity = shadowsEnabled ? String(SHADOW_OPACITY) : '0';
          scheduleDraw();
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
