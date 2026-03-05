/**
 * Pure-geometry utilities used by the shadow renderer.
 *
 * All coordinates are GeoJSON-style [longitude, latitude] pairs.
 * Distances are in metres; angles in radians unless noted.
 */

import type { Position } from '../types';

// ---------------------------------------------------------------------------
// Convex hull  (Andrew's monotone chain, O(n log n))
// ---------------------------------------------------------------------------

/**
 * Returns the convex hull of a set of 2-D points as a **closed** GeoJSON ring
 * (first === last point).  Input points are [lon, lat] pairs.
 *
 * Returns an empty array when fewer than 3 distinct points are supplied.
 */
export function convexHull(points: Position[]): Position[] {
  if (points.length < 3) return [];

  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const cross = (O: Position, A: Position, B: Position): number =>
    (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0]);

  // Build lower hull
  const lower: Position[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  // Build upper hull
  const upper: Position[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  // Remove last point of each half (duplicate of first of the other)
  upper.pop();
  lower.pop();

  const hull = [...lower, ...upper];
  if (hull.length < 3) return [];

  // Close the ring
  hull.push(hull[0]);
  return hull;
}

// ---------------------------------------------------------------------------
// Douglas-Peucker polyline simplification
// ---------------------------------------------------------------------------

/** Perpendicular distance from point P to the segment (A → B) in degrees. */
function perpendicularDist(P: Position, A: Position, B: Position): number {
  const dx = B[0] - A[0];
  const dy = B[1] - A[1];
  if (dx === 0 && dy === 0) {
    // Degenerate segment – use point distance
    return Math.hypot(P[0] - A[0], P[1] - A[1]);
  }
  const t = ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / (dx * dx + dy * dy);
  const projX = A[0] + t * dx;
  const projY = A[1] + t * dy;
  return Math.hypot(P[0] - projX, P[1] - projY);
}

/**
 * Simplify a polygon ring using the Douglas-Peucker algorithm.
 *
 * @param ring   Closed GeoJSON ring (first === last point).
 * @param eps    Tolerance in degrees (≈ 1e-5 ≈ 1 m at mid-latitudes).
 * @returns      Simplified closed ring; preserves at least 4 points (3 + close).
 */
export function simplifyRing(ring: Position[], eps: number): Position[] {
  // Work on the open ring (drop the closing duplicate)
  const open = ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
    ? ring.slice(0, -1)
    : ring;

  if (open.length <= 3) return ring;

  const simplified = rdp(open, eps);

  // Re-close
  simplified.push(simplified[0]);
  return simplified;
}

function rdp(points: Position[], eps: number): Position[] {
  if (points.length <= 2) return points;

  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDist(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > eps) {
    const left = rdp(points.slice(0, maxIdx + 1), eps);
    const right = rdp(points.slice(maxIdx), eps);
    return [...left.slice(0, -1), ...right];
  }

  return [first, last];
}

// ---------------------------------------------------------------------------
// Coordinate conversion helpers
// ---------------------------------------------------------------------------

const DEG_TO_RAD = Math.PI / 180;
const METRES_PER_DEGREE_LAT = 111_320;

/**
 * Convert a displacement in metres (ΔlonM, ΔlatM) to degree offsets at the
 * given reference latitude.
 */
export function metresToDegrees(
  deltaLonMetres: number,
  deltaLatMetres: number,
  refLatDeg: number,
): { dLon: number; dLat: number } {
  const cosLat = Math.cos(refLatDeg * DEG_TO_RAD);
  return {
    dLon: deltaLonMetres / (METRES_PER_DEGREE_LAT * cosLat),
    dLat: deltaLatMetres / METRES_PER_DEGREE_LAT,
  };
}

/**
 * Return the geographic centroid (average) of a polygon ring.
 */
export function ringCentroid(ring: Position[]): { lat: number; lon: number } {
  const open = ring[ring.length - 1][0] === ring[0][0] &&
    ring[ring.length - 1][1] === ring[0][1]
    ? ring.slice(0, -1)
    : ring;

  const sumLon = open.reduce((acc, p) => acc + p[0], 0);
  const sumLat = open.reduce((acc, p) => acc + p[1], 0);
  return { lon: sumLon / open.length, lat: sumLat / open.length };
}
