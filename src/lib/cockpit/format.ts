// Cockpit text helpers: clock stamps, numbers, countries, shares. Times come
// from src/lib/time.ts (zonedParts on the device zone: moments, never due dates).

import { zonedParts } from '@/lib/time';

const pad = (n: number): string => n.toString().padStart(2, '0');

/** "14:03:27" on the device zone; '' for a missing or bad instant. */
export function clockText(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return '';
  const p = zonedParts(at);
  return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** "12,480": digits grouped by thousands. */
export function countText(n: number): string {
  const whole = Math.round(n);
  const sign = whole < 0 ? '-' : '';
  return (
    sign +
    Math.abs(whole)
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  );
}

/** "42%": a share of a whole, rounded; "0%" with nothing to share. */
export function shareText(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  return `${Math.round((part / whole) * 100).toString()}%`;
}

let regionNames: Intl.DisplayNames | null | undefined;

/** "IN" -> "India"; "??" and anything unknown -> "Unknown". */
export function countryName(code: string | null | undefined): string {
  if (typeof code !== 'string' || !/^[A-Za-z]{2}$/.test(code)) return 'Unknown';
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames('en', { type: 'region' });
    } catch {
      regionNames = null;
    }
  }
  const upper = code.toUpperCase();
  try {
    const name = regionNames?.of(upper);
    return name !== undefined && name !== upper ? name : upper;
  } catch {
    return 'Unknown';
  }
}

/** A day bar's label: the day of the month ("27") from "2026-10-27". */
export function dayOfMonth(day: string): string {
  const d = /^\d{4}-\d{2}-(\d{2})/.exec(day)?.[1];
  return d === undefined ? '' : String(Number(d));
}

/** The dot's accessible name. */
export function dotLabel(level: 'green' | 'amber' | 'red' | 'grey'): string {
  if (level === 'green') return 'Cockpit: all clear';
  if (level === 'amber') return 'Cockpit: watch';
  if (level === 'red') return 'Cockpit: needs you';
  return 'Cockpit';
}

/** A UUID anywhere in a search box: the Logs tab then filters to that trace. */
export function traceIdIn(query: string): string | null {
  return (
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
      .exec(query)?.[0]
      ?.toLowerCase() ?? null
  );
}
