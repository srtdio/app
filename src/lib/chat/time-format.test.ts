import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browserTimeZone,
  formatMessageTime,
  formatShortDate,
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

describe('formatMessageTime', () => {
  it('renders the same instant on two workspace clocks', () => {
    expect(formatMessageTime(CREATED_AT, 'Asia/Kolkata')).toBe('00:15');
    expect(formatMessageTime(CREATED_AT, 'Europe/London')).toBe('19:45');
    expect(formatMessageTime(CREATED_AT, 'UTC')).toBe('18:45');
  });

  it('accepts an epoch-ms instant (a live Agora server time) too', () => {
    expect(formatMessageTime(Date.parse('2026-09-22T06:05:00Z'), 'America/New_York')).toBe('02:05');
  });

  it('degrades an unknown zone to the browser zone and an unparseable instant to empty', () => {
    browserInMumbai();
    expect(formatMessageTime(CREATED_AT, 'Not/AZone')).toBe('00:15');
    expect(formatMessageTime('garbage', 'UTC')).toBe('');
  });
});

describe('formatShortDate', () => {
  it('renders the civil date in the workspace zone', () => {
    expect(formatShortDate(CREATED_AT, 'Asia/Kolkata')).toBe('Sep 23');
    expect(formatShortDate(CREATED_AT, 'Europe/London')).toBe('Sep 22');
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
