/**
 * Sun-position service – thin wrapper around the SunCalc library.
 *
 * SunCalc azimuth convention: measured from south towards west (radians).
 *   0   = south
 *   π/2 = west
 *  ±π   = north
 *  −π/2 = east
 *
 * We re-export a normalised "north-based" azimuth used by the shadow renderer:
 *   northAzimuth = suncalcAzimuth + π   (mod 2π)
 *   0 = north, π/2 = east, π = south, 3π/2 = west
 */

import SunCalc from 'suncalc';
import type { SunPosition } from '../types';

/** Sun must be at least this many radians above the horizon to cast shadows. */
const MIN_ALTITUDE_RAD = 0.017; // ≈ 1°

const TWO_PI = 2 * Math.PI;

/**
 * Compute the sun's position for the given date/time and location.
 *
 * @param date  The moment to evaluate (defaults to now).
 * @param lat   Observer latitude in degrees.
 * @param lon   Observer longitude in degrees.
 */
export function getSunPosition(
  date: Date = new Date(),
  lat: number,
  lon: number,
): SunPosition {
  const raw = SunCalc.getPosition(date, lat, lon);

  // Convert to north-based azimuth (add π, wrap to [0, 2π))
  const northAzimuth = ((raw.azimuth + Math.PI) % TWO_PI + TWO_PI) % TWO_PI;

  return {
    altitudeRad: raw.altitude,
    azimuthRad: northAzimuth,
    isAboveHorizon: raw.altitude > MIN_ALTITUDE_RAD,
  };
}

/**
 * Returns sunrise and sunset times for a given date + location.
 * Useful for clamping the time slider range.
 */
export function getDaylight(
  date: Date,
  lat: number,
  lon: number,
): { sunrise: Date | null; sunset: Date | null } {
  const times = SunCalc.getTimes(date, lat, lon);
  return {
    sunrise: isFinite(times.sunrise.getTime()) ? times.sunrise : null,
    sunset: isFinite(times.sunset.getTime()) ? times.sunset : null,
  };
}

/**
 * Human-readable description of sun position (for debugging / status bar).
 */
export function describeSunPosition(pos: SunPosition): string {
  const alt = ((pos.altitudeRad * 180) / Math.PI).toFixed(1);
  const az = ((pos.azimuthRad * 180) / Math.PI).toFixed(1);
  return pos.isAboveHorizon
    ? `Sun: alt ${alt}°  az ${az}°`
    : 'Sun below horizon';
}
