import { describe, expect, it } from 'vitest';
import { dayPillLabel, withDaySeparators } from '@/components/chat/day-separators';
import type { ThreadMessage } from '@/lib/chat/thread';

// A fixed clock: 28 Sep 2026, 10:00 UTC.
const NOW = Date.parse('2026-09-28T10:00:00Z');

function message(id: string, iso: string): ThreadMessage {
  return {
    id,
    senderUserId: 'u1',
    body: id,
    createdAt: iso,
    time: Date.parse(iso),
    provisionalTime: false,
    mine: false,
    attachments: [],
    sharedPostIds: [],
    sharedBriefIds: [],
    reply: null,
    state: 'sent',
    status: 'sent',
    reactions: [],
  };
}

function pills(messages: ThreadMessage[], timeZone = 'UTC'): string[] {
  return withDaySeparators(messages, NOW, timeZone).flatMap((item) =>
    item.kind === 'day' ? [item.label] : [],
  );
}

describe('dayPillLabel', () => {
  it('reads Today, then the formatWhen day: Yesterday, weekday, D MMM, other year', () => {
    expect(dayPillLabel('2026-09-28', NOW, 'UTC')).toBe('Today');
    expect(dayPillLabel('2026-09-27', NOW, 'UTC')).toBe('Yesterday');
    expect(dayPillLabel('2026-09-24', NOW, 'UTC')).toBe('Thu');
    expect(dayPillLabel('2026-09-03', NOW, 'UTC')).toBe('3 Sep');
    expect(dayPillLabel('2025-12-31', NOW, 'UTC')).toBe('31 Dec 2025');
  });

  it('crosses a month boundary for Yesterday by calendar', () => {
    const firstOfOct = Date.parse('2026-10-01T09:00:00Z');
    expect(dayPillLabel('2026-09-30', firstOfOct, 'UTC')).toBe('Yesterday');
  });
});

describe('withDaySeparators', () => {
  it('puts one pill between two messages on different days', () => {
    const items = withDaySeparators(
      [message('a', '2026-09-27T20:00:00Z'), message('b', '2026-09-28T08:00:00Z')],
      NOW,
      'UTC',
    );
    expect(items.map((i) => (i.kind === 'day' ? `day:${i.label}` : i.message.id))).toEqual([
      'day:Yesterday',
      'a',
      'day:Today',
      'b',
    ]);
  });

  it('adds no pill between two messages on the same day', () => {
    expect(
      pills([message('a', '2026-09-28T01:00:00Z'), message('b', '2026-09-28T09:00:00Z')]),
    ).toEqual(['Today']);
  });

  it('groups by the workspace clock, not UTC', () => {
    // 17:00 and 19:00 UTC on the 26th straddle midnight in Kolkata (+05:30).
    const list = [message('a', '2026-09-26T17:00:00Z'), message('b', '2026-09-26T19:00:00Z')];
    expect(pills(list, 'UTC')).toEqual(['Sat']);
    expect(pills(list, 'Asia/Kolkata')).toEqual(['Sat', 'Yesterday']);
  });

  it('keeps every message in order and never starts a day on a time of 0', () => {
    const pending = { ...message('p', '2026-09-28T09:00:00Z'), createdAt: '', time: 0 };
    const items = withDaySeparators([pending], NOW, 'UTC');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'message', index: 0 });
  });
});
