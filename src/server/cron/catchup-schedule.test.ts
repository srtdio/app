import { describe, expect, it } from 'vitest';
import type { DecideSlot, SlotDecision } from './catchup-contracts';
import { decideSlot } from './catchup-schedule';

// Tests are written from the frozen contract (DecideSlot) only. Every expected
// UTC instant is computed by hand in a comment; nothing here calls the code
// under test to build an expectation.
//
// Calendar anchors (2026): Jan 1 is a Thursday, so 2026-10-16 is a Friday
// (day 289, 288 % 7 = 1 day after Thursday). Hence:
//   Fri 2026-10-09, Mon 2026-10-12, Tue 2026-10-13, Wed 2026-10-14,
//   Fri 2026-10-16, Sat 2026-10-17, Sun 2026-10-18, Mon 2026-10-19,
//   Fri 2026-10-30, Sun 2026-11-01 (US fall-back), Mon 2026-11-02.
//
// Offsets used:
//   Asia/Kolkata      +05:30 (no DST)
//   Asia/Kathmandu    +05:45 (no DST)
//   America/New_York  -04:00 (EDT) until Sun 2026-11-01 02:00 local, then -05:00 (EST)
//   Pacific/Auckland  +13:00 (NZDT, DST began Sun 2026-09-27)
//   Pacific/Honolulu  -10:00 (no DST)

const decide: DecideSlot = decideSlot;

function at(iso: string): Date {
  return new Date(iso);
}

function expectSend(d: SlotDecision): Extract<SlotDecision, { send: true }> {
  if (!d.send) {
    throw new Error(`expected send:true, got send:false reason=${d.reason}`);
  }
  return d;
}

function expectSkip(d: SlotDecision, reason: string): void {
  expect(d).toEqual({ send: false, reason });
}

describe('decideSlot: timezone resolution', () => {
  it('null timezone -> no_timezone (never guesses a zone)', () => {
    // 10:30 IST on a Tuesday would otherwise be a valid slot.
    expectSkip(decide(null, at('2026-10-13T05:00:00.000Z')), 'no_timezone');
  });

  it('null timezone -> no_timezone even at a UTC 10:30 weekday instant', () => {
    // Guards against a silent UTC fallback.
    expectSkip(decide(null, at('2026-10-13T10:30:00.000Z')), 'no_timezone');
  });

  it('unknown IANA zone -> invalid_timezone', () => {
    expectSkip(decide('Mars/Olympus_Mons', at('2026-10-13T05:00:00.000Z')), 'invalid_timezone');
  });

  it('garbage zone string -> invalid_timezone', () => {
    expectSkip(decide('not a zone', at('2026-10-13T10:30:00.000Z')), 'invalid_timezone');
  });
});

describe('decideSlot: Asia/Kolkata (+05:30)', () => {
  const TZ = 'Asia/Kolkata';

  // Tue 2026-10-13 10:30 IST = 10:30 - 5:30 = 05:00Z.
  it('10:29 local -> not_slot_time', () => {
    expectSkip(decide(TZ, at('2026-10-13T04:59:00.000Z')), 'not_slot_time');
  });

  it('10:29:59.999 local -> not_slot_time', () => {
    expectSkip(decide(TZ, at('2026-10-13T04:59:59.999Z')), 'not_slot_time');
  });

  it('10:30 local Tue -> send 10:30, window Mon 15:30 -> Tue 10:30', () => {
    const d = expectSend(decide(TZ, at('2026-10-13T05:00:00.000Z')));
    expect(d.slot).toBe('10:30');
    expect(d.local).toEqual({ isoDate: '2026-10-13', weekday: 'Tuesday', day: 13, month: 'Oct' });
    expect(d.previous).toEqual({ slot: '15:30', weekday: 'Monday', sameDay: false });
    // start: Mon 2026-10-12 15:30 IST = 15:30 - 5:30 = 10:00Z.
    // end:   Tue 2026-10-13 10:30 IST = 05:00Z.
    expect(d.window).toEqual({
      start: '2026-10-12T10:00:00.000Z',
      end: '2026-10-13T05:00:00.000Z',
    });
  });

  it('10:59 local -> send 10:30 (window end is the slot instant, not now)', () => {
    // 10:59:59.999 IST = 05:29:59.999Z.
    const d = expectSend(decide(TZ, at('2026-10-13T05:29:59.999Z')));
    expect(d.slot).toBe('10:30');
    expect(d.window.end).toBe('2026-10-13T05:00:00.000Z');
    expect(d.window.start).toBe('2026-10-12T10:00:00.000Z');
  });

  it('10:59 local (whole minute) -> send', () => {
    // 10:59 IST = 05:29Z.
    expect(expectSend(decide(TZ, at('2026-10-13T05:29:00.000Z'))).slot).toBe('10:30');
  });

  it('11:00 local -> not_slot_time', () => {
    // 11:00 IST = 05:30Z.
    expectSkip(decide(TZ, at('2026-10-13T05:30:00.000Z')), 'not_slot_time');
  });

  it('midday between slots -> not_slot_time', () => {
    // 13:00 IST = 07:30Z.
    expectSkip(decide(TZ, at('2026-10-13T07:30:00.000Z')), 'not_slot_time');
  });

  it('exact UTC slot clock (10:30Z) is not a slot in IST -> not_slot_time', () => {
    // 10:30Z = 16:00 IST, past the 15:30 window.
    expectSkip(decide(TZ, at('2026-10-13T10:30:00.000Z')), 'not_slot_time');
  });

  // Tue 2026-10-13 15:30 IST = 15:30 - 5:30 = 10:00Z.
  it('15:29 local -> not_slot_time', () => {
    expectSkip(decide(TZ, at('2026-10-13T09:59:00.000Z')), 'not_slot_time');
  });

  it('15:30 local Tue -> send 15:30, window same-day 10:30 -> 15:30', () => {
    const d = expectSend(decide(TZ, at('2026-10-13T10:00:00.000Z')));
    expect(d.slot).toBe('15:30');
    expect(d.local).toEqual({ isoDate: '2026-10-13', weekday: 'Tuesday', day: 13, month: 'Oct' });
    expect(d.previous).toEqual({ slot: '10:30', weekday: 'Tuesday', sameDay: true });
    // start: Tue 10:30 IST = 05:00Z; end: Tue 15:30 IST = 10:00Z.
    expect(d.window).toEqual({
      start: '2026-10-13T05:00:00.000Z',
      end: '2026-10-13T10:00:00.000Z',
    });
  });

  it('15:47:12.345 local -> window end truncated to the slot instant', () => {
    // 15:47:12.345 IST = 10:17:12.345Z.
    const d = expectSend(decide(TZ, at('2026-10-13T10:17:12.345Z')));
    expect(d.slot).toBe('15:30');
    expect(d.window.end).toBe('2026-10-13T10:00:00.000Z');
  });

  it('15:59 local -> send 15:30', () => {
    // 15:59 IST = 10:29Z.
    expect(expectSend(decide(TZ, at('2026-10-13T10:29:00.000Z'))).slot).toBe('15:30');
  });

  it('16:00 local -> not_slot_time', () => {
    // 16:00 IST = 10:30Z.
    expectSkip(decide(TZ, at('2026-10-13T10:30:00.000Z')), 'not_slot_time');
  });

  it('Monday 10:30 -> window starts Friday 15:30 (exact instants)', () => {
    // end:   Mon 2026-10-12 10:30 IST = 05:00Z.
    // start: Fri 2026-10-09 15:30 IST = 10:00Z.
    const d = expectSend(decide(TZ, at('2026-10-12T05:00:00.000Z')));
    expect(d.slot).toBe('10:30');
    expect(d.local).toEqual({ isoDate: '2026-10-12', weekday: 'Monday', day: 12, month: 'Oct' });
    expect(d.previous).toEqual({ slot: '15:30', weekday: 'Friday', sameDay: false });
    expect(d.window).toEqual({
      start: '2026-10-09T10:00:00.000Z',
      end: '2026-10-12T05:00:00.000Z',
    });
  });

  it('Friday 15:30 -> send (Friday is a weekday)', () => {
    // Fri 2026-10-16 15:30 IST = 10:00Z; start Fri 10:30 IST = 05:00Z.
    const d = expectSend(decide(TZ, at('2026-10-16T10:00:00.000Z')));
    expect(d.local).toEqual({ isoDate: '2026-10-16', weekday: 'Friday', day: 16, month: 'Oct' });
    expect(d.window).toEqual({
      start: '2026-10-16T05:00:00.000Z',
      end: '2026-10-16T10:00:00.000Z',
    });
  });

  it('Saturday 10:30 local -> weekend', () => {
    // Sat 2026-10-17 10:30 IST = 05:00Z.
    expectSkip(decide(TZ, at('2026-10-17T05:00:00.000Z')), 'weekend');
  });

  it('Sunday 15:30 local -> weekend', () => {
    // Sun 2026-10-18 15:30 IST = 10:00Z.
    expectSkip(decide(TZ, at('2026-10-18T10:00:00.000Z')), 'weekend');
  });
});

describe('decideSlot: Asia/Kathmandu (+05:45)', () => {
  const TZ = 'Asia/Kathmandu';

  // Wed 2026-10-14 10:30 NPT = 10:30 - 5:45 = 04:45Z.
  it('10:29 local -> not_slot_time', () => {
    expectSkip(decide(TZ, at('2026-10-14T04:44:00.000Z')), 'not_slot_time');
  });

  it('10:30 local Wed -> send, window Tue 15:30 -> Wed 10:30', () => {
    const d = expectSend(decide(TZ, at('2026-10-14T04:45:00.000Z')));
    expect(d.slot).toBe('10:30');
    expect(d.local).toEqual({
      isoDate: '2026-10-14',
      weekday: 'Wednesday',
      day: 14,
      month: 'Oct',
    });
    expect(d.previous).toEqual({ slot: '15:30', weekday: 'Tuesday', sameDay: false });
    // start: Tue 2026-10-13 15:30 NPT = 15:30 - 5:45 = 09:45Z.
    expect(d.window).toEqual({
      start: '2026-10-13T09:45:00.000Z',
      end: '2026-10-14T04:45:00.000Z',
    });
  });

  it('10:59 local -> send', () => {
    // 10:59 NPT = 05:14Z.
    expect(expectSend(decide(TZ, at('2026-10-14T05:14:00.000Z'))).slot).toBe('10:30');
  });

  it('11:00 local -> not_slot_time', () => {
    // 11:00 NPT = 05:15Z.
    expectSkip(decide(TZ, at('2026-10-14T05:15:00.000Z')), 'not_slot_time');
  });

  it('a :30 UTC-offset guess (05:00Z = 10:45 NPT) still sends; 04:30Z (10:15 NPT) does not', () => {
    // Guards against treating +5:45 as +5:30 or +6:00.
    expect(expectSend(decide(TZ, at('2026-10-14T05:00:00.000Z'))).slot).toBe('10:30');
    expectSkip(decide(TZ, at('2026-10-14T04:30:00.000Z')), 'not_slot_time');
  });

  // Wed 15:30 NPT = 09:45Z.
  it('15:29 local -> not_slot_time', () => {
    expectSkip(decide(TZ, at('2026-10-14T09:44:00.000Z')), 'not_slot_time');
  });

  it('15:30 local -> send, window same-day 10:30 -> 15:30', () => {
    const d = expectSend(decide(TZ, at('2026-10-14T09:45:00.000Z')));
    expect(d.slot).toBe('15:30');
    expect(d.previous).toEqual({ slot: '10:30', weekday: 'Wednesday', sameDay: true });
    expect(d.window).toEqual({
      start: '2026-10-14T04:45:00.000Z',
      end: '2026-10-14T09:45:00.000Z',
    });
  });

  it('15:59 local -> send; 16:00 local -> not_slot_time', () => {
    // 15:59 NPT = 10:14Z; 16:00 NPT = 10:15Z.
    expect(expectSend(decide(TZ, at('2026-10-14T10:14:00.000Z'))).slot).toBe('15:30');
    expectSkip(decide(TZ, at('2026-10-14T10:15:00.000Z')), 'not_slot_time');
  });

  it('Monday 10:30 -> window from Friday 15:30', () => {
    // end:   Mon 2026-10-12 10:30 NPT = 04:45Z.
    // start: Fri 2026-10-09 15:30 NPT = 09:45Z.
    const d = expectSend(decide(TZ, at('2026-10-12T04:45:00.000Z')));
    expect(d.previous).toEqual({ slot: '15:30', weekday: 'Friday', sameDay: false });
    expect(d.window).toEqual({
      start: '2026-10-09T09:45:00.000Z',
      end: '2026-10-12T04:45:00.000Z',
    });
  });
});

describe('decideSlot: America/New_York (negative offset, DST)', () => {
  const TZ = 'America/New_York';

  it('Tue 10:30 EDT -> send, window Mon 15:30 EDT -> Tue 10:30 EDT', () => {
    // Tue 2026-10-13 10:30 EDT = 10:30 + 4 = 14:30Z.
    // Mon 2026-10-12 15:30 EDT = 15:30 + 4 = 19:30Z.
    const d = expectSend(decide(TZ, at('2026-10-13T14:30:00.000Z')));
    expect(d.slot).toBe('10:30');
    expect(d.local).toEqual({ isoDate: '2026-10-13', weekday: 'Tuesday', day: 13, month: 'Oct' });
    expect(d.previous).toEqual({ slot: '15:30', weekday: 'Monday', sameDay: false });
    expect(d.window).toEqual({
      start: '2026-10-12T19:30:00.000Z',
      end: '2026-10-13T14:30:00.000Z',
    });
  });

  it('Monday after fall-back: window spans the DST change (Fri EDT -> Mon EST)', () => {
    // end:   Mon 2026-11-02 10:30 EST = 10:30 + 5 = 15:30Z.
    // start: Fri 2026-10-30 15:30 EDT = 15:30 + 4 = 19:30Z.
    // (A fixed-offset implementation would give 20:30Z or 14:30Z.)
    const d = expectSend(decide(TZ, at('2026-11-02T15:30:00.000Z')));
    expect(d.slot).toBe('10:30');
    expect(d.local).toEqual({ isoDate: '2026-11-02', weekday: 'Monday', day: 2, month: 'Nov' });
    expect(d.previous).toEqual({ slot: '15:30', weekday: 'Friday', sameDay: false });
    expect(d.window).toEqual({
      start: '2026-10-30T19:30:00.000Z',
      end: '2026-11-02T15:30:00.000Z',
    });
  });

  it('Mon 2026-11-02 edges in EST: 10:29 no, 10:30 yes, 10:59 yes, 11:00 no', () => {
    // 10:29 EST = 15:29Z, 10:59 EST = 15:59Z, 11:00 EST = 16:00Z.
    expectSkip(decide(TZ, at('2026-11-02T15:29:00.000Z')), 'not_slot_time');
    expect(expectSend(decide(TZ, at('2026-11-02T15:30:00.000Z'))).slot).toBe('10:30');
    expect(expectSend(decide(TZ, at('2026-11-02T15:59:00.000Z'))).slot).toBe('10:30');
    expectSkip(decide(TZ, at('2026-11-02T16:00:00.000Z')), 'not_slot_time');
  });

  it('Mon 2026-11-02 at 14:30Z (10:30 if still EDT, actually 09:30 EST) -> not_slot_time', () => {
    expectSkip(decide(TZ, at('2026-11-02T14:30:00.000Z')), 'not_slot_time');
  });

  it('Mon 2026-11-02 15:30 EST edges: 15:29 no, 15:30 yes, 15:59 yes, 16:00 no', () => {
    // 15:29 EST = 20:29Z, 15:30 = 20:30Z, 15:59 = 20:59Z, 16:00 = 21:00Z.
    expectSkip(decide(TZ, at('2026-11-02T20:29:00.000Z')), 'not_slot_time');
    const d = expectSend(decide(TZ, at('2026-11-02T20:30:00.000Z')));
    expect(d.slot).toBe('15:30');
    expect(d.previous).toEqual({ slot: '10:30', weekday: 'Monday', sameDay: true });
    expect(d.window).toEqual({
      start: '2026-11-02T15:30:00.000Z',
      end: '2026-11-02T20:30:00.000Z',
    });
    expect(expectSend(decide(TZ, at('2026-11-02T20:59:00.000Z'))).slot).toBe('15:30');
    expectSkip(decide(TZ, at('2026-11-02T21:00:00.000Z')), 'not_slot_time');
  });

  it('Sunday of fall-back at a slot clock -> weekend', () => {
    // Sun 2026-11-01 10:30 EST = 15:30Z.
    expectSkip(decide(TZ, at('2026-11-01T15:30:00.000Z')), 'weekend');
  });
});

describe('decideSlot: weekday is decided by the LOCAL date, not UTC', () => {
  it('Pacific/Auckland: UTC Friday but local Saturday 10:30 -> weekend', () => {
    // Sat 2026-10-17 10:30 NZDT (+13) = Fri 2026-10-16 21:30Z.
    expectSkip(decide('Pacific/Auckland', at('2026-10-16T21:30:00.000Z')), 'weekend');
  });

  it('Pacific/Auckland: UTC Sunday but local Monday 10:30 -> send, window from local Friday', () => {
    // Mon 2026-10-19 10:30 NZDT = Sun 2026-10-18 21:30Z.
    // Fri 2026-10-16 15:30 NZDT = Fri 2026-10-16 02:30Z.
    const d = expectSend(decide('Pacific/Auckland', at('2026-10-18T21:30:00.000Z')));
    expect(d.slot).toBe('10:30');
    expect(d.local).toEqual({ isoDate: '2026-10-19', weekday: 'Monday', day: 19, month: 'Oct' });
    expect(d.previous).toEqual({ slot: '15:30', weekday: 'Friday', sameDay: false });
    expect(d.window).toEqual({
      start: '2026-10-16T02:30:00.000Z',
      end: '2026-10-18T21:30:00.000Z',
    });
  });

  it('Pacific/Honolulu: UTC Saturday but local Friday 15:30 -> send with local Friday date', () => {
    // Fri 2026-10-16 15:30 HST (-10) = Sat 2026-10-17 01:30Z.
    // Fri 2026-10-16 10:30 HST = 20:30Z.
    const d = expectSend(decide('Pacific/Honolulu', at('2026-10-17T01:30:00.000Z')));
    expect(d.slot).toBe('15:30');
    expect(d.local).toEqual({ isoDate: '2026-10-16', weekday: 'Friday', day: 16, month: 'Oct' });
    expect(d.previous).toEqual({ slot: '10:30', weekday: 'Friday', sameDay: true });
    expect(d.window).toEqual({
      start: '2026-10-16T20:30:00.000Z',
      end: '2026-10-17T01:30:00.000Z',
    });
  });

  it('Pacific/Honolulu: UTC Monday but local Sunday 15:30 -> weekend', () => {
    // Sun 2026-10-18 15:30 HST = Mon 2026-10-19 01:30Z.
    expectSkip(decide('Pacific/Honolulu', at('2026-10-19T01:30:00.000Z')), 'weekend');
  });
});
