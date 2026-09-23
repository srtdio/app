import { describe, expect, it } from 'vitest';
import { formatMessageTime, formatShortDate, safeTimeZone } from '@/lib/chat/time-format';

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

  it('degrades an unknown zone to UTC and an unparseable instant to empty', () => {
    expect(formatMessageTime(CREATED_AT, 'Not/AZone')).toBe('18:45');
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
  it('keeps a valid IANA zone and falls back to UTC otherwise', () => {
    expect(safeTimeZone('Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(safeTimeZone('')).toBe('UTC');
    expect(safeTimeZone('Mars/Olympus')).toBe('UTC');
  });
});
