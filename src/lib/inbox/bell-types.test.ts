import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BELL_ONLY_EVENT_TYPES,
  BELL_PLAN_EVENT_TYPES,
  NOT_CHAT_MENTION_OR,
  ONLY_BELL_OR,
  chatMessageHref,
  isBellEntry,
  isBellPlanEvent,
  isBellRow,
  onlyBellEntries,
  planHref,
  withoutBellEntries,
} from '@/lib/inbox/bell-types';
import { INBOX_EVENT_TYPES } from '@srtdio/schemas';

describe('isBellEntry: the one bell / Activity split', () => {
  it('a chat mention is a bell row', () => {
    expect(isBellEntry({ eventType: 'mention', entityType: 'chat_channel' })).toBe(true);
  });

  it('post and brief mentions stay in Activity', () => {
    expect(isBellEntry({ eventType: 'mention', entityType: 'post' })).toBe(false);
    expect(isBellEntry({ eventType: 'mention', entityType: 'brief' })).toBe(false);
    expect(isBellEntry({ eventType: 'mention', entityType: null })).toBe(false);
  });

  it('reminder and scheduled outcomes are bell rows whatever the entity', () => {
    for (const eventType of BELL_ONLY_EVENT_TYPES) {
      expect(isBellEntry({ eventType, entityType: 'chat_channel' })).toBe(true);
      expect(isBellEntry({ eventType, entityType: null })).toBe(true);
    }
  });

  it('every other event type stays in Activity', () => {
    const others = INBOX_EVENT_TYPES.filter(
      (t) => t !== 'mention' && !(BELL_ONLY_EVENT_TYPES as readonly string[]).includes(t),
    );
    expect(others.length).toBeGreaterThan(5);
    for (const eventType of others) {
      expect(isBellEntry({ eventType, entityType: 'post' })).toBe(false);
    }
  });

  it('every bell type is a canonical inbox event type', () => {
    for (const t of BELL_ONLY_EVENT_TYPES) expect(INBOX_EVENT_TYPES).toContain(t);
  });

  it('the plan alerts are bell-only rows (item 12): plan and plan_item entities alike', () => {
    expect([...BELL_PLAN_EVENT_TYPES]).toEqual([
      'plan_opened',
      'plan_deleted',
      'plan_date_changed',
      'plan_updated',
      'plan_review',
      'plan_comment',
    ]);
    for (const eventType of BELL_PLAN_EVENT_TYPES) {
      expect(isBellPlanEvent(eventType)).toBe(true);
      expect(isBellEntry({ eventType, entityType: 'plan' })).toBe(true);
      expect(isBellEntry({ eventType, entityType: 'plan_item' })).toBe(true);
      expect(isBellRow({ event_type: eventType, entity_type: 'plan' })).toBe(true);
    }
    expect(isBellPlanEvent('comment')).toBe(false);
  });

  it('a plan alert opens /plans/{plan_id}, with ?item= when it names one', () => {
    expect(planHref('p1', null)).toBe('/plans/p1');
    expect(planHref('p1', 'i 2')).toBe('/plans/p1?item=i%202');
    expect(planHref('p1', '')).toBe('/plans/p1');
  });

  it('reads raw snake_case rows the same way', () => {
    expect(isBellRow({ event_type: 'reminder', entity_type: 'chat_channel' })).toBe(true);
    expect(isBellRow({ event_type: 'comment', entity_type: 'post' })).toBe(false);
  });
});

describe('query helpers', () => {
  function recorder() {
    const calls: { method: string; args: unknown[] }[] = [];
    const q = {
      not(...args: unknown[]) {
        calls.push({ method: 'not', args });
        return q;
      },
      or(...args: unknown[]) {
        calls.push({ method: 'or', args });
        return q;
      },
    };
    return { q, calls };
  }

  it('withoutBellEntries drops the bell-only types and chat mentions (null entity kept)', () => {
    const { q, calls } = recorder();
    withoutBellEntries(q);
    expect(calls).toEqual([
      {
        method: 'not',
        args: [
          'event_type',
          'in',
          '(reminder,scheduled_sent,scheduled_failed,plan_opened,plan_deleted,plan_date_changed,plan_updated,plan_review,plan_comment)',
        ],
      },
      { method: 'or', args: [NOT_CHAT_MENTION_OR] },
    ]);
    expect(NOT_CHAT_MENTION_OR).toContain('entity_type.is.null');
  });

  it('onlyBellEntries keeps exactly the bell rows', () => {
    const { q, calls } = recorder();
    onlyBellEntries(q);
    expect(calls).toEqual([{ method: 'or', args: [ONLY_BELL_OR] }]);
    expect(ONLY_BELL_OR).toBe(
      'event_type.in.(reminder,scheduled_sent,scheduled_failed,plan_opened,plan_deleted,plan_date_changed,plan_updated,plan_review,plan_comment),and(event_type.eq.mention,entity_type.eq.chat_channel)',
    );
  });
});

describe('chatMessageHref: the Activity chat-mention deep link', () => {
  it('opens a chat at a message', () => {
    expect(chatMessageHref('dm__a', 'm 1')).toBe('/chat?channel=dm__a&message=m%201');
  });
  it('opens the chat alone without a message', () => {
    expect(chatMessageHref('group__g', null)).toBe('/chat?channel=group__g');
  });
});

describe('inbox_mark_all_read skips every bell-only type', () => {
  const MIGRATION = fileURLToPath(
    new URL('../../../supabase/migrations/20261012190000_plan_part_2b.sql', import.meta.url),
  );

  it("the 2b migration's NOT IN list contains every BELL_ONLY_EVENT_TYPES value", () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const body = sql.slice(sql.indexOf('FUNCTION public.inbox_mark_all_read('));
    const match = /event_type NOT IN \(([^)]*)\)/.exec(body);
    expect(match).not.toBeNull();
    const skipped = [...(match?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    for (const eventType of BELL_ONLY_EVENT_TYPES) expect(skipped).toContain(eventType);
  });
});
