const DAY_INDEX: Record<string, number> = {
  Mo: 0,
  Tu: 1,
  We: 2,
  Th: 3,
  Fr: 4,
  Sa: 5,
  Su: 6,
};

type Interval = { start: number; end: number };

function allDays(): number[] {
  return [0, 1, 2, 3, 4, 5, 6];
}

function parseDays(dayPart: string | null): number[] {
  if (!dayPart) return allDays();
  const compact = dayPart.replace(/\s+/g, '');
  const tokens = compact.split(',').filter(Boolean);
  const out = new Set<number>();

  for (const token of tokens) {
    if (token.includes('-')) {
      const [from, to] = token.split('-');
      const start = DAY_INDEX[from];
      const end = DAY_INDEX[to];
      if (start === undefined || end === undefined) continue;
      if (start <= end) {
        for (let d = start; d <= end; d++) out.add(d);
      } else {
        for (let d = start; d <= 6; d++) out.add(d);
        for (let d = 0; d <= end; d++) out.add(d);
      }
      continue;
    }
    const idx = DAY_INDEX[token];
    if (idx !== undefined) out.add(idx);
  }

  return out.size ? Array.from(out) : allDays();
}

function parseTimeRanges(body: string): { start: number; end: number }[] {
  if (body.includes('24/7')) {
    return [{ start: 0, end: 24 * 60 }];
  }

  const ranges: { start: number; end: number }[] = [];
  const re = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g;
  let match: RegExpExecArray | null = null;

  while ((match = re.exec(body))) {
    const h1 = Number(match[1]);
    const m1 = Number(match[2]);
    const h2 = Number(match[3]);
    const m2 = Number(match[4]);
    if ([h1, m1, h2, m2].some((n) => Number.isNaN(n))) continue;
    if (h1 < 0 || h1 > 23 || h2 < 0 || h2 > 24 || m1 < 0 || m1 > 59 || m2 < 0 || m2 > 59) continue;
    ranges.push({ start: h1 * 60 + m1, end: Math.min(24 * 60, h2 * 60 + m2) });
  }

  return ranges;
}

function dayAndMinute(now: Date, timeZone: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const dayToken = wd.slice(0, 2);
  const day = DAY_INDEX[dayToken] ?? 0;

  return { day, minute: hour * 60 + minute };
}

function formatHHmm(totalMinutes: number): string {
  const clamped = Math.max(0, Math.min(totalMinutes, 24 * 60));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function getOpenUntilToday(
  openingHours: string | undefined,
  now = new Date(),
  timeZone = 'Europe/Copenhagen',
): { isOpen: boolean; closesAt?: string } {
  if (!openingHours) {
    const { minute } = dayAndMinute(now, timeZone);
    const defaultStart = 10 * 60;
    const defaultEnd = 16 * 60;
    if (minute >= defaultStart && minute < defaultEnd) {
      return { isOpen: true, closesAt: '16:00' };
    }
    return { isOpen: false };
  }

  const schedule: Interval[][] = [[], [], [], [], [], [], []];
  const rules = openingHours.split(';').map((s) => s.trim()).filter(Boolean);

  for (const rule of rules) {
    const dayRule = rule.match(/^([A-Za-z,\-\s]+?)\s+(.+)$/);
    const dayPart = dayRule && /\b(Mo|Tu|We|Th|Fr|Sa|Su)\b/.test(dayRule[1]) ? dayRule[1] : null;
    const body = dayRule && dayPart ? dayRule[2] : rule;
    const days = parseDays(dayPart);

    if (/\b(off|closed)\b/i.test(body)) {
      for (const d of days) schedule[d] = [];
      continue;
    }

    const ranges = parseTimeRanges(body);
    for (const d of days) {
      for (const range of ranges) {
        if (range.start === range.end) {
          schedule[d].push({ start: 0, end: 24 * 60 });
          continue;
        }
        if (range.start < range.end) {
          schedule[d].push({ start: range.start, end: range.end });
          continue;
        }
        schedule[d].push({ start: range.start, end: 24 * 60 });
        schedule[(d + 1) % 7].push({ start: 0, end: range.end });
      }
    }
  }

  const { day, minute } = dayAndMinute(now, timeZone);
  const today = schedule[day].sort((a, b) => a.start - b.start);
  for (const interval of today) {
    if (minute >= interval.start && minute < interval.end) {
      return { isOpen: true, closesAt: formatHHmm(interval.end) };
    }
  }

  return { isOpen: false };
}
