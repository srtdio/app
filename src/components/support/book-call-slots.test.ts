import { describe, expect, it } from 'vitest';
import {
  chosenInstant,
  slotLabel,
  suggestedSlots,
  tomorrowInputValue,
  zonedInstant,
} from './book-call-slots';

const iso = (slots: { at: Date }[]): string[] => slots.map((s) => s.at.toISOString());

describe('suggestedSlots', () => {
  it('skips the weekend: from a Saturday, Monday 11:00 and 16:00, then Tuesday 11:00', () => {
    const slots = suggestedSlots(new Date('2026-10-17T10:00:00Z'), 'Asia/Kolkata');
    expect(slots.map((s) => s.label)).toEqual([
      'Mon 19 Oct, 11:00',
      'Mon 19 Oct, 16:00',
      'Tue 20 Oct, 11:00',
    ]);
    expect(iso(slots)).toEqual([
      '2026-10-19T05:30:00.000Z',
      '2026-10-19T10:30:00.000Z',
      '2026-10-20T05:30:00.000Z',
    ]);
  });

  it('from a Friday the next weekdays are Monday and Tuesday', () => {
    const slots = suggestedSlots(new Date('2026-10-16T09:00:00Z'), 'Europe/London');
    expect(slots.map((s) => s.label)).toEqual([
      'Mon 19 Oct, 11:00',
      'Mon 19 Oct, 16:00',
      'Tue 20 Oct, 11:00',
    ]);
  });

  it("counts 'today' in the viewer's time zone, not UTC", () => {
    const now = new Date('2026-10-15T20:00:00Z');
    // Already Friday in Kolkata: Monday and Tuesday.
    expect(suggestedSlots(now, 'Asia/Kolkata').map((s) => s.label)).toEqual([
      'Mon 19 Oct, 11:00',
      'Mon 19 Oct, 16:00',
      'Tue 20 Oct, 11:00',
    ]);
    // Still Thursday in New York: Friday, then Monday.
    const ny = suggestedSlots(now, 'America/New_York');
    expect(ny.map((s) => s.label)).toEqual([
      'Fri 16 Oct, 11:00',
      'Fri 16 Oct, 16:00',
      'Mon 19 Oct, 11:00',
    ]);
    expect(ny[0]!.at.toISOString()).toBe('2026-10-16T15:00:00.000Z');
  });

  it('honours a daylight saving change between today and the slot', () => {
    const slots = suggestedSlots(new Date('2026-10-30T14:00:00Z'), 'America/New_York');
    expect(slots[0]!.label).toBe('Mon 2 Nov, 11:00');
    expect(slots[0]!.at.toISOString()).toBe('2026-11-02T16:00:00.000Z');
  });
});

describe('custom day and time', () => {
  const tz = 'Asia/Kolkata';
  const now = new Date('2026-10-17T10:00:00Z');
  const slots = suggestedSlots(now, tz);
  const minDate = tomorrowInputValue(now, tz);
  const pick = (choice: Parameters<typeof chosenInstant>[0]['choice'], date = '', time = '') =>
    chosenInstant({ choice, slots, date, time, minDate, timeZone: tz });

  it('the date input starts tomorrow in the zone', () => {
    expect(minDate).toBe('2026-10-18');
    expect(tomorrowInputValue(new Date('2026-12-31T20:00:00Z'), tz)).toBe('2027-01-02');
  });

  it('Book waits for a slot or both fields', () => {
    expect(pick(null)).toBeNull();
    expect(pick({ kind: 'slot', index: 1 })).toEqual(slots[1]!.at);
    expect(pick({ kind: 'other' })).toBeNull();
    expect(pick({ kind: 'other' }, '2026-10-21')).toBeNull();
    expect(pick({ kind: 'other' }, '', '14:15')).toBeNull();
    expect(pick({ kind: 'other' }, '2026-10-21', '14:07')).toBeNull();
    expect(pick({ kind: 'other' }, '2026-10-17', '14:15')).toBeNull();
    expect(pick({ kind: 'other' }, '2026-10-21', '14:15')?.toISOString()).toBe(
      '2026-10-21T08:45:00.000Z',
    );
  });

  it('labels a custom time like the slots', () => {
    const at = zonedInstant({ year: 2026, month: 10, day: 21 }, 14, 15, tz);
    expect(slotLabel(at, tz)).toBe('Wed 21 Oct, 14:15');
  });
});
