// @vitest-environment jsdom
import { act, createElement } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO } from './config';
import DemoPage from './DemoPage';
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
    // 1 Oct 2026 is a Thursday: Mon 28 to Wed 30 Sep lead, outside the month.
    expect(grid.slice(0, 4)).toEqual([
      { day: day(2026, 9, 28), outside: true },
      { day: day(2026, 9, 29), outside: true },
      { day: day(2026, 9, 30), outside: true },
      { day: day(2026, 10, 1), outside: false },
    ]);
    expect(grid).toHaveLength(42);
    // 31 Oct is a Saturday: Sun 1 Nov to Sun 8 Nov trail.
    expect(grid.slice(33)).toEqual(
      Array.from({ length: 9 }, (_, i) => ({
        day: day(2026, 10 + (i === 0 ? 0 : 1), i === 0 ? 31 : i),
        outside: i > 0,
      })),
    );
    // Feb 2027 starts on a Monday (four weeks): two whole weeks of March trail.
    const feb = monthGrid(day(2027, 2, 1));
    expect(feb.filter((c) => !c.outside)).toHaveLength(28);
    expect(feb.slice(28).every((c) => c.outside && c.day.m === 3)).toBe(true);
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

// /demo is prerendered once at build time and hydrated on any later day, so
// its server HTML must not depend on the date (no hydration mismatch).
describe('/demo server render', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const renderAt = (iso: string): string => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
    return renderToString(createElement(DemoPage));
  };

  it('is identical on different dates, months and month lengths', () => {
    const october = renderAt('2026-10-14T04:30:00Z');
    expect(renderAt('2027-01-29T04:30:00Z')).toBe(october);
    // February 2027 starts on a Monday: a four-week month.
    expect(renderAt('2027-02-01T04:30:00Z')).toBe(october);
    expect(october).not.toMatch(/October 2026|data-day/);
    expect(october.match(/class="cal-pad"/g)).toHaveLength(42);
    expect(october).not.toMatch(/cal-out/);
  });
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// After hydration every month fills all 42 cells: its own days as buttons, the
// adjacent months' days as hidden, inert text, so no blank week row is left.
describe('/demo calendar after hydration', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['a four-week month (Feb 2027)', '2027-02-01T04:30:00Z', 28],
    ['a five-week month (Oct 2026)', '2026-10-14T04:30:00Z', 31],
    ['a six-week month (Aug 2026)', '2026-07-31T04:30:00Z', 31],
  ])('%s renders exactly 42 cells', async (_label, iso, days) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
    const host = document.createElement('div');
    host.innerHTML = renderToString(createElement(DemoPage));
    let root: Root | undefined;
    await act(async () => {
      root = hydrateRoot(host, createElement(DemoPage));
    });
    const grid = host.querySelector('.cal-grid');
    if (grid === null) throw new Error('no calendar grid');
    const cells = [...grid.children].filter((el) => !el.classList.contains('cal-wd'));
    expect(cells).toHaveLength(42);
    const own = grid.querySelectorAll('button.cal-day');
    expect(own).toHaveLength(days);
    const outside = grid.querySelectorAll('.cal-out');
    expect(outside).toHaveLength(42 - days);
    for (const el of outside) {
      expect(el.tagName).toBe('SPAN');
      expect(el.getAttribute('aria-hidden')).toBe('true');
      expect(el.hasAttribute('tabindex')).toBe(false);
      expect(el.querySelector('button, a, [tabindex]')).toBeNull();
    }
    expect(grid.querySelectorAll('.cal-pad')).toHaveLength(0);
    act(() => root?.unmount());
  });
});
