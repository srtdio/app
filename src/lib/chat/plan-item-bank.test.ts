// @vitest-environment jsdom
// Bank meets Plan on the item screen: bucket picks, the save signal, the Who
// can see this copy, the More menu per kind, and the Undo strip that outlives
// the screen (Move to bank, Delete): the write goes only when the strip ends.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToastOptions } from '@/components/ui/toast/types';
import { UNDO_MS } from '@/lib/undo';
import { PAST_DAY_ERROR, planItError } from '@/components/pages/plan-tab/bank-parts';
import { MOVE_TO_BANK_LOCKED, moveToBankError } from './bank-plan-copy';
import {
  BUCKETS_SAVED,
  BUCKETS_SAVING,
  TEAM_ONLY_LINE,
  bankIdeaMenu,
  bankIdeaOf,
  bucketSaveLabel,
  clientSeesLine,
  plannedConceptMenu,
  runDetachedUndo,
  toggleBucket,
  withIdeaFlags,
  withNewBucket,
} from './plan-item-bank';
import type { PlanItemRow } from './plans';

const ITEM: PlanItemRow = {
  id: 'i1',
  plan_id: null,
  kind: 'concept',
  position: 0,
  title: 'Monsoon reel',
  description: null,
  post_id: null,
  created_at: '2026-11-06T00:00:00Z',
  show_to_client: false,
  starred_at: null,
  archived_at: null,
};

const noop = (): void => {};
const NoIcon = (): null => null;
const ids = (rows: ReadonlyArray<{ id: string }>): string[] => rows.map((r) => r.id);
const labels = (rows: ReadonlyArray<{ label: string }>): string[] => rows.map((r) => r.label);

describe('bucket picks', () => {
  it('toggles one id, keeping the options order', () => {
    expect(toggleBucket([], 'a')).toEqual(['a']);
    expect(toggleBucket(['a', 'b'], 'a')).toEqual(['b']);
    expect(toggleBucket(['c'], 'a', ['a', 'b', 'c'])).toEqual(['a', 'c']);
  });
  it('a new bucket is picked once', () => {
    expect(withNewBucket(['a'], 'n')).toEqual(['a', 'n']);
    expect(withNewBucket(['n'], 'n')).toEqual(['n']);
  });
  it('the save signal: nothing, Saving…, then Saved', () => {
    expect(bucketSaveLabel({ saving: false, savedOnce: false })).toBeNull();
    expect(bucketSaveLabel({ saving: true, savedOnce: false })).toBe(BUCKETS_SAVING);
    expect(bucketSaveLabel({ saving: true, savedOnce: true })).toBe(BUCKETS_SAVING);
    expect(bucketSaveLabel({ saving: false, savedOnce: true })).toBe(BUCKETS_SAVED);
  });
});

describe('Who can see this', () => {
  it('team only and client lines', () => {
    expect(TEAM_ONLY_LINE).toBe(
      'Approvers see it once it is in a shared plan, or when you show it.',
    );
    expect(clientSeesLine('Asha and Ravi')).toBe(
      'Asha and Ravi see this idea and all its comments.',
    );
    expect(TEAM_ONLY_LINE).not.toContain('—');
  });
  it('flags apply over the item; the idea shape carries the comment count', () => {
    const shown = withIdeaFlags(ITEM, { show_to_client: true });
    expect(shown.show_to_client).toBe(true);
    expect(bankIdeaOf(shown, 3)).toMatchObject({ id: 'i1', comment_count: 3, format: null });
  });
});

describe('More menu per kind', () => {
  it('a planned concept: Move, Edit, Send to chat, Move to bank, Remove last', () => {
    const rows = plannedConceptMenu(
      [
        { id: 'move', label: 'Move to another day', icon: NoIcon, onSelect: noop },
        { id: 'edit', label: 'Edit concept', icon: NoIcon, onSelect: noop },
      ],
      { id: 'remove', label: 'Remove from plan', icon: NoIcon, tone: 'danger', onSelect: noop },
      { onSendToChat: noop, onMoveToBank: noop },
    );
    expect(ids(rows)).toEqual(['move', 'edit', 'send-to-chat', 'move-to-bank', 'remove']);
    expect(labels(rows)).toContain('Move to bank');
  });
  it('a bank idea: Plan it, Edit idea, Send to chat, Show, Star, Archive, Delete last', () => {
    const on = {
      onPlanIt: noop,
      onEdit: noop,
      onSendToChat: noop,
      onShow: noop,
      onHide: noop,
      onStar: noop,
      onArchive: noop,
      onDelete: noop,
    };
    expect(labels(bankIdeaMenu(ITEM, on))).toEqual([
      'Plan it',
      'Edit idea',
      'Send to chat',
      'Show to approvers',
      'Star',
      'Archive',
      'Delete',
    ]);
    expect(
      labels(bankIdeaMenu({ show_to_client: true, starred_at: 'x', archived_at: 'y' }, on)),
    ).toEqual([
      'Plan it',
      'Edit idea',
      'Send to chat',
      'Hide from approvers',
      'Unstar',
      'Unarchive',
      'Delete',
    ]);
    expect(bankIdeaMenu(ITEM, on).at(-1)?.tone).toBe('danger');
  });
});

describe('copy', () => {
  it('Move to bank and Plan it errors', () => {
    expect(moveToBankError('post_approved')).toBe(MOVE_TO_BANK_LOCKED);
    expect(MOVE_TO_BANK_LOCKED).toBe("Couldn't move to bank. Approved posts are locked.");
    expect(planItError('P0001: past_date')).toBe(PAST_DAY_ERROR);
    expect(PAST_DAY_ERROR).toBe("Couldn't plan it. Past days can't be planned.");
  });
});

describe('runDetachedUndo (Move to bank undo timing)', () => {
  afterEach(() => vi.useRealTimers());

  /** A toast stand-in: expires after durationMs unless its action ran. */
  function fakeToast(): { show: (o: ToastOptions) => string; last: () => ToastOptions } {
    let last: ToastOptions | null = null;
    return {
      show: (o) => {
        last = o;
        if (o.kind === 'undo' && o.onExpire !== undefined && typeof o.durationMs === 'number') {
          const expire = o.onExpire;
          const timer = setTimeout(expire, o.durationMs);
          if (o.action !== undefined) {
            const press = o.action.onPress;
            o.action.onPress = () => {
              clearTimeout(timer);
              press();
            };
          }
        }
        return 'id';
      },
      last: () => {
        if (last === null) throw new Error('no toast');
        return last;
      },
    };
  }

  it('the write goes only when the strip ends (UNDO_MS)', async () => {
    vi.useFakeTimers();
    const toast = fakeToast();
    const commit = vi.fn(async () => undefined);
    runDetachedUndo(toast.show, { label: 'Moved to bank', commit });
    expect(toast.last()).toMatchObject({
      title: 'Moved to bank',
      kind: 'undo',
      durationMs: UNDO_MS,
    });
    vi.advanceTimersByTime(UNDO_MS - 1);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('Undo means the write never goes and the state comes back', () => {
    vi.useFakeTimers();
    const toast = fakeToast();
    const commit = vi.fn(async () => undefined);
    const revert = vi.fn();
    runDetachedUndo(toast.show, { label: 'Moved to bank', commit, revert });
    toast.last().action?.onPress();
    vi.advanceTimersByTime(UNDO_MS * 2);
    expect(commit).not.toHaveBeenCalled();
    expect(revert).toHaveBeenCalledTimes(1);
  });

  it('a hidden page commits at once, and only once', () => {
    vi.useFakeTimers();
    const toast = fakeToast();
    const commit = vi.fn(async () => undefined);
    runDetachedUndo(toast.show, { label: 'Idea deleted', commit });
    window.dispatchEvent(new Event('pagehide'));
    expect(commit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(UNDO_MS);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
