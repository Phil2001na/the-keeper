import { config } from '../config.js';

/**
 * Standing rituals. A touchpoint with a recurrence renews itself after firing —
 * the reliability lives in the scheduler, not in the model remembering to
 * reschedule. Three shapes, all in local (config.timezone) wall-clock time:
 *
 *   daily@HH:MM
 *   weekly:mon|tue|wed|thu|fri|sat|sun@HH:MM
 *   monthly:1-28@HH:MM   or   monthly:last@HH:MM
 */

const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

interface Rule {
  freq: 'daily' | 'weekly' | 'monthly';
  dow?: number; // 0=sun .. 6=sat
  dom?: number | 'last';
  hh: number;
  mm: number;
}

export function parseRecurrence(rec: string): Rule | null {
  const m = rec
    .trim()
    .toLowerCase()
    .match(/^(daily|weekly:([a-z]{3})|monthly:(\d{1,2}|last))@(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  if (hh > 23 || mm > 59) return null;
  if (m[1] === 'daily') return { freq: 'daily', hh, mm };
  if (m[2]) {
    const dow = DOW.indexOf(m[2] as (typeof DOW)[number]);
    if (dow === -1) return null;
    return { freq: 'weekly', dow, hh, mm };
  }
  const dom = m[3] === 'last' ? ('last' as const) : Number(m[3]);
  if (dom !== 'last' && (dom < 1 || dom > 28)) return null; // 29-31 don't exist every month
  return { freq: 'monthly', dom, hh, mm };
}

/** Wall-clock parts of an instant in the configured timezone. */
function partsInTz(date: Date): { y: number; m: number; d: number; hh: number; mm: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) map[p.type] = p.value;
  return {
    y: Number(map.year),
    m: Number(map.month),
    d: Number(map.day),
    hh: Number(map.hour) % 24, // "24" can appear at midnight
    mm: Number(map.minute),
  };
}

/**
 * The UTC instant at which the configured timezone's wall clock reads
 * y-m-d hh:mm. Two correction passes handle any offset (incl. DST zones).
 */
export function zonedUtc(y: number, m: number, d: number, hh: number, mm: number): Date {
  let t = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const p = partsInTz(new Date(t));
    t += Date.UTC(y, m - 1, d, hh, mm) - Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
  }
  return new Date(t);
}

/** UTC instant of local midnight that started today (for "today so far" queries). */
export function localMidnightUtc(now = new Date()): Date {
  const p = partsInTz(now);
  return zonedUtc(p.y, p.m, p.d, 0, 0);
}

/** UTC instant of local midnight on the 1st of the month `back` months ago. */
export function monthStartUtc(back = 0, now = new Date()): Date {
  const p = partsInTz(now);
  const total = p.y * 12 + (p.m - 1) - back;
  return zonedUtc(Math.floor(total / 12), (total % 12) + 1, 1, 0, 0);
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Weekday (0=sun..6=sat) of a calendar date — a timezone-free fact. */
function weekdayOf(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function nextDay(c: { y: number; m: number; d: number }): { y: number; m: number; d: number } {
  if (c.d < daysInMonth(c.y, c.m)) return { ...c, d: c.d + 1 };
  if (c.m < 12) return { y: c.y, m: c.m + 1, d: 1 };
  return { y: c.y + 1, m: 1, d: 1 };
}

/**
 * The next UTC instant this rule fires, strictly after `after` (with a small
 * margin so a just-fired ritual can't immediately re-fire). Walks the local
 * calendar day by day — immune to DST and month-length edge cases.
 */
export function nextOccurrence(rec: string, after = new Date()): Date | null {
  const r = parseRecurrence(rec);
  if (!r) return null;
  let c = partsInTz(after);
  for (let i = 0; i < 70; i++) {
    const hit =
      r.freq === 'daily' ||
      (r.freq === 'weekly' && weekdayOf(c.y, c.m, c.d) === r.dow) ||
      (r.freq === 'monthly' &&
        (r.dom === 'last' ? c.d === daysInMonth(c.y, c.m) : c.d === r.dom));
    if (hit) {
      const t = zonedUtc(c.y, c.m, c.d, r.hh, r.mm);
      if (t.getTime() > after.getTime() + 60_000) return t;
    }
    c = { ...nextDay(c), hh: 0, mm: 0 };
  }
  return null;
}
