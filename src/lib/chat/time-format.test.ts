import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browserTimeZone,
  formatShortDate,
  formatShortDateOnly,
  safeTimeZone,
  workspaceTimeZone,
} from '@/lib/chat/time-format';

/** Pretend the browser runs on Mumbai time, so a UTC fallback would be visible. */
function browserInMumbai(): void {
  const real = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
    this: Intl.DateTimeFormat,
  ) {
    return { ...real.call(this), timeZone: 'Asia/Kolkata' };
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// One server instant read on two workspace clocks: the same chat_messages row
// renders at different wall-clock times for a Mumbai and a London workspace, and
// never on the machine running the test.
const CREATED_AT = '2026-09-22T18:45:00.123456+00:00';

describe('formatShortDate', () => {
  it('renders the civil date in the workspace zone', () => {
    const now = new Date('2026-10-23T12:00:00Z');
    expect(formatShortDate(CREATED_AT, 'Asia/Kolkata', now)).toBe('23 Sep');
    expect(formatShortDate(CREATED_AT, 'Europe/London', now)).toBe('22 Sep');
  });

  it('adds the year only when it is not the current year', () => {
    const now = new Date('2027-02-01T12:00:00Z');
    expect(formatShortDate(CREATED_AT, 'Europe/London', now)).toBe('22 Sep 2026');
  });
});

describe('safeTimeZone', () => {
  it('keeps a valid IANA zone and falls back to the browser zone (not UTC) otherwise', () => {
    browserInMumbai();
    expect(browserTimeZone()).toBe('Asia/Kolkata');
    expect(safeTimeZone('Europe/London')).toBe('Europe/London');
    expect(safeTimeZone('')).toBe('Asia/Kolkata');
    expect(safeTimeZone('Mars/Olympus')).toBe('Asia/Kolkata');
  });
});

describe('workspaceTimeZone', () => {
  it('uses the workspace zone when set, else the browser zone', () => {
    browserInMumbai();
    expect(workspaceTimeZone('Europe/London')).toBe('Europe/London');
    expect(workspaceTimeZone(null)).toBe('Asia/Kolkata');
    expect(workspaceTimeZone(undefined)).toBe('Asia/Kolkata');
    expect(workspaceTimeZone('')).toBe('Asia/Kolkata');
  });
});

describe('formatShortDateOnly', () => {
  it('formats a DATE column with no timezone shift', () => {
    expect(formatShortDateOnly('2026-01-01')).toBe('1 Jan');
    expect(formatShortDateOnly('2026-12-31')).toBe('31 Dec');
    expect(formatShortDateOnly('2026-10-02')).toBe('2 Oct');
  });

  it('renders anything that is not YYYY-MM-DD as empty', () => {
    expect(formatShortDateOnly('')).toBe('');
    expect(formatShortDateOnly('2026-13-01')).toBe('');
    expect(formatShortDateOnly('2026-10-02T00:00:00Z')).toBe('');
  });
});
