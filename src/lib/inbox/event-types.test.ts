// The drift guard, at the unit level. This suite plus the DB-backed
// tests/comments/event-type-constraint.test.ts are what keep the incident this PR
// fixes from recurring silently: comment_batch_create / post_ready_notify emitted
// event_types ('checkpoints_added' / 'post_ready') the inbox_entries CHECK
// constraint rejected, so the whole transaction rolled back.
//
// Contract:
//   - INBOX_EVENT_TYPES is the single canonical list; the DB constraint must equal
//     it exactly (asserted against a live constraint in the comments DB suite).
//   - every emitter list is a SUBSET of the canonical list, so nothing can emit a
//     value the DB would reject.

import { describe, expect, it, vi } from 'vitest';
import { INBOX_EVENT_TYPES, InboxEntrySchema } from '@srtdio/schemas';
import { WORKER_INBOX_EVENT_TYPES } from '@srtdio/inbox';
import { CATCHUP_EVENT_TYPES } from '@/server/cron/catchup-send';
import { logger } from '@/lib/logger';
import { warnUnknownEventType } from '@/components/pages/activity/data';

/** The 16 values that must match the DB constraint. Spelled out so an accidental
 *  edit to the canonical list (add/remove/reorder-away a value) fails here too. */
const EXPECTED_CANONICAL = [
  'comment',
  'mention',
  'stage_change',
  'comment_resolved',
  'brief_created',
  'brief_closed',
  'asset_uploaded',
  'asset_version_added',
  'invite',
  'trial_warning',
  'billing_failure',
  'system',
  'checkpoints_added',
  'post_ready',
  'checkpoint_reopened',
  'checkpoint_asked',
];

describe('INBOX_EVENT_TYPES (canonical event_type list)', () => {
  it('is exactly the expected 16 values, with no duplicates', () => {
    expect([...INBOX_EVENT_TYPES]).toEqual(EXPECTED_CANONICAL);
    expect(new Set(INBOX_EVENT_TYPES).size).toBe(INBOX_EVENT_TYPES.length);
  });

  it('includes the feedback-ledger values the incident was missing', () => {
    expect(INBOX_EVENT_TYPES).toContain('checkpoints_added');
    expect(INBOX_EVENT_TYPES).toContain('post_ready');
  });

  it('is the exact accept set of the zod InboxEntrySchema.event_type', () => {
    const base = {
      id: '00000000-0000-0000-0000-000000000000',
      user_id: '00000000-0000-0000-0000-000000000000',
      workspace_id: '00000000-0000-0000-0000-000000000000',
      entity_type: null,
      entity_id: null,
      scope: 'everything' as const,
      scope_key: null,
      tier: 'active' as const,
      payload: {},
      read_at: null,
      snoozed_until: null,
      actor_user_id: null,
      email_sent_at: null,
      created_at: '2026-07-17T00:00:00.000Z',
      deleted_at: null,
    };
    for (const eventType of INBOX_EVENT_TYPES) {
      expect(InboxEntrySchema.safeParse({ ...base, event_type: eventType }).success).toBe(true);
    }
    expect(InboxEntrySchema.safeParse({ ...base, event_type: 'not_a_real_event' }).success).toBe(
      false,
    );
  });
});

describe('emitter lists are subsets of the canonical list', () => {
  const canonical = new Set<string>(INBOX_EVENT_TYPES);

  it('the inbox-writer worker only emits canonical values', () => {
    for (const eventType of WORKER_INBOX_EVENT_TYPES) {
      expect(canonical.has(eventType)).toBe(true);
    }
  });

  it('the catch-up email only reads canonical values', () => {
    for (const eventType of CATCHUP_EVENT_TYPES) {
      expect(canonical.has(eventType)).toBe(true);
    }
  });
});

describe('warnUnknownEventType', () => {
  it('logs once for an unknown value and never for a canonical one', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      // A value guaranteed not in the canonical list.
      warnUnknownEventType('zzz_unknown_event_only_here');
      warnUnknownEventType('zzz_unknown_event_only_here');
      expect(warn).toHaveBeenCalledTimes(1);

      warn.mockClear();
      warnUnknownEventType('checkpoints_added');
      warnUnknownEventType('comment');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
