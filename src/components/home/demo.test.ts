import { describe, expect, it } from 'vitest';
import { DEMO, PLANS } from './config';
import {
  DEMO_ERRORS,
  addDays,
  bookingSummary,
  isBookable,
  mobileDigits,
  monthGrid,
  monthRange,
  todayIn,
  validateDemo,
  type CalendarDay,
  type DemoForm,
} from './demo';

// Wednesday 14 Oct 2026, 10:00 IST.
const NOW = new Date('2026-10-14T04:30:00Z');
const today = todayIn(NOW);
const day = (y: number, m: number, d: number): CalendarDay => ({ y, m, d });

describe('bookable dates (IST, weekdays, tomorrow to 30 days)', () => {
  it('today is IST today', () => {
    expect(today).toEqual(day(2026, 10, 14));
  });

  it('today is off, tomorrow is on', () => {
    expect(isBookable(today, today)).toBe(false);
    expect(isBookable(day(2026, 10, 15), today)).toBe(true);
  });

  it('weekends are off', () => {
    expect(isBookable(day(2026, 10, 17), today)).toBe(false); // Saturday
    expect(isBookable(day(2026, 10, 18), today)).toBe(false); // Sunday
    expect(isBookable(day(2026, 10, 19), today)).toBe(true); // Monday
  });

  it('day 30 is on, day 31 is off', () => {
    // 14 Oct + 30 = Fri 13 Nov; + 31 = Sat 14 Nov, so check on a weekday run too.
    expect(isBookable(addDays(today, 30), today)).toBe(true);
    expect(isBookable(addDays(today, 31), today)).toBe(false);
    const monday = day(2026, 10, 19);
    expect(isBookable(addDays(monday, 31), monday)).toBe(false); // Thu 19 Nov, day 31
    expect(isBookable(addDays(monday, 30), monday)).toBe(true); // Wed 18 Nov, day 30
  });

  it('the IST boundary: 23:30 UTC is already the next day in India', () => {
    const late = todayIn(new Date('2026-10-14T23:30:00Z'));
    expect(late).toEqual(day(2026, 10, 15));
    // Thursday 15th is now today (off); Friday 16th is tomorrow (on).
    expect(isBookable(day(2026, 10, 15), late)).toBe(false);
    expect(isBookable(day(2026, 10, 16), late)).toBe(true);
    // 18:29 UTC is still the 14th in IST.
    expect(todayIn(new Date('2026-10-14T18:29:00Z'))).toEqual(day(2026, 10, 14));
  });

  it('the calendar is Monday first and spans the window', () => {
    const grid = monthGrid(day(2026, 10, 1));
    // 1 Oct 2026 is a Thursday: three blanks (Mon to Wed) first.
    expect(grid.slice(0, 4)).toEqual([null, null, null, day(2026, 10, 1)]);
    expect(grid.length % 7).toBe(0);
    expect(monthRange(today)).toEqual({ first: day(2026, 10, 1), last: day(2026, 11, 1) });
  });

  it('the window, slots and timezone come from the config', () => {
    expect(DEMO.timeZone).toBe('Asia/Kolkata');
    expect(DEMO.firstDay).toBe(1);
    expect(DEMO.lastDay).toBe(30);
    expect(DEMO.slots).toEqual(['11:00 am', '12:30 pm', '3:00 pm', '4:30 pm', '6:00 pm']);
  });
});

describe('the summary', () => {
  it('reads "<Day> <date> <Mon>, <time> IST · 30 min"', () => {
    expect(bookingSummary(day(2026, 10, 16), '11:00 am')).toBe('Fri 16 Oct, 11:00 am IST · 30 min');
  });
});

describe('demo form errors', () => {
  const valid: DemoForm = {
    name: 'Asha',
    email: 'you@agency.com',
    mobile: '9876543210',
    day: day(2026, 10, 15),
    slot: '3:00 pm',
  };

  it('a valid form has no errors', () => {
    expect(validateDemo(valid)).toEqual({});
  });

  it('each field has its own message', () => {
    expect(validateDemo({ ...valid, name: '  ' })).toEqual({ name: 'Enter your name.' });
    expect(validateDemo({ ...valid, email: 'you@agency' })).toEqual({
      email: 'Enter an email like you@agency.com.',
    });
    expect(validateDemo({ ...valid, day: null })).toEqual({ day: 'Pick a day for the call.' });
    expect(validateDemo({ ...valid, slot: null })).toEqual({ slot: 'Pick a time for the call.' });
  });

  it('mobile: 10 digits starting 6 to 9', () => {
    const msg = { mobile: 'Enter a 10 digit mobile number.' };
    expect(validateDemo({ ...valid, mobile: '987654321' })).toEqual(msg);
    expect(validateDemo({ ...valid, mobile: '5876543210' })).toEqual(msg);
    expect(validateDemo({ ...valid, mobile: '6000000000' })).toEqual({});
  });

  it('the mobile field keeps digits only, at most 10', () => {
    expect(mobileDigits('+91 98765-43210 99')).toBe('9198765432');
    expect(mobileDigits('98a76')).toBe('9876');
  });

  it('an empty form lists every error, in form order', () => {
    const errors = validateDemo({ name: '', email: '', mobile: '', day: null, slot: null });
    expect(Object.keys(errors)).toEqual(['name', 'email', 'mobile', 'day', 'slot']);
    expect(Object.values(errors)).toEqual(Object.values(DEMO_ERRORS));
  });
});

describe('plans config', () => {
  it('four plans, approved prices, Enterprise books a demo', () => {
    expect(PLANS.map((p) => [p.name, p.price])).toEqual([
      ['Solo', '₹499'],
      ['Studio', '₹749'],
      ['Agency', '₹999'],
      ['Enterprise', 'Custom'],
    ]);
    expect(PLANS.map((p) => p.cta.href)).toEqual(['/signup', '/signup', '/signup', '/demo']);
  });
});
