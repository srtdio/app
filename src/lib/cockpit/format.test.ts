import { describe, expect, it } from 'vitest';
import {
  clockText,
  countText,
  countryName,
  dayOfMonth,
  dotLabel,
  shareText,
  traceIdIn,
} from '@/lib/cockpit/format';

describe('cockpit format', () => {
  it('stamps HH:MM:SS', () => {
    expect(clockText('2026-10-27T10:04:09Z')).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(clockText(null)).toBe('');
    expect(clockText('nope')).toBe('');
  });
  it('groups thousands and shares', () => {
    expect(countText(12480)).toBe('12,480');
    expect(countText(7)).toBe('7');
    expect(shareText(1, 4)).toBe('25%');
    expect(shareText(3, 0)).toBe('0%');
  });
  it('names countries; ?? is Unknown', () => {
    expect(countryName('IN')).toBe('India');
    expect(countryName('??')).toBe('Unknown');
    expect(countryName(null)).toBe('Unknown');
  });
  it('labels the dot', () => {
    expect(dotLabel('green')).toBe('Cockpit: all clear');
    expect(dotLabel('amber')).toBe('Cockpit: watch');
    expect(dotLabel('red')).toBe('Cockpit: needs you');
  });
  it('finds a pasted trace id', () => {
    expect(traceIdIn('trace 0190A000-0000-7000-8000-000000000001 x')).toBe(
      '0190a000-0000-7000-8000-000000000001',
    );
    expect(traceIdIn('invite-send')).toBeNull();
    expect(dayOfMonth('2026-10-07')).toBe('7');
  });
});
