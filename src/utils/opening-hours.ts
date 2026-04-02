import type { CafeOpeningHours, DayKey } from '../types';

const DAY_MAP: Record<string, DayKey> = {
  Mon: 'mo', Tue: 'tu', Wed: 'we', Thu: 'th', Fri: 'fr', Sat: 'sa', Sun: 'su',
};

function todayKey(now: Date, timeZone: string): DayKey {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
  }).formatToParts(now);
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  return DAY_MAP[wd] ?? 'mo';
}

function currentMinuteInTZ(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const min  = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + min;
}

function parseHHmm(value: string): number | null {
  if (value === '24:00') return 24 * 60;
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

type OpenResult =
  | { isOpen: true; closesAt?: string }
  | { isOpen: false; reason: 'no_data' | 'closed_today' | 'closed_now' };

export function getOpenUntilToday(
  openingHours: CafeOpeningHours | undefined,
  now = new Date(),
  timeZone = 'Europe/Copenhagen',
): OpenResult {
  if (!openingHours) return { isOpen: false, reason: 'no_data' };

  const key = todayKey(now, timeZone);
  const day = openingHours[key];
  if (!day) return { isOpen: false, reason: 'no_data' };

  // Closed sentinel
  if (day.open === '00:00' && day.close === '00:00') return { isOpen: false, reason: 'closed_today' };

  // 24/7 sentinel
  if (day.open === '00:00' && day.close === '24:00') return { isOpen: true };

  const openMin  = parseHHmm(day.open);
  const closeMin = parseHHmm(day.close);
  if (openMin === null || closeMin === null) return { isOpen: false, reason: 'no_data' };

  const nowMin = currentMinuteInTZ(now, timeZone);
  if (nowMin >= openMin && nowMin < closeMin) {
    return { isOpen: true, closesAt: day.close };
  }

  return { isOpen: false, reason: 'closed_now' };
}
