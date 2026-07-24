import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement, ReactNode } from 'react';

// The full component is provider-bound (trace) and pulls chat-attachment wiring;
// both hooks are mocked so the component can be rendered to static markup with
// no provider tree, mirroring PostCard.test.tsx's node-SSR render.
vi.mock('@/lib/trace-context', () => ({
  useNewTrace: () => () => 'trace-test',
}));
vi.mock('@/lib/chat/use-chat-attachments', () => ({
  useChatAttachments: () => ({ presignEnabled: false, presignCache: {} }),
}));

import {
  FeedbackLedger,
  LEDGER_SELECT,
  MAX_NOTE_CHARS,
  NOTE_PLACEHOLDER,
  NOTIFY_LABEL,
  SUBPOINT_SELECT,
  NOTIFICATION_SELECT,
  buildNotificationView,
  buildResolveArgs,
  checkpointCountLabel,
  checkpointState,
  clientCircleInteractive,
  editedMarker,
  friendlyAcceptError,
  friendlyDeleteError,
  friendlyEditError,
  friendlyResolveError,
  isCheckpointAuthor,
  ledgerCounts,
  ledgerProgress,
  notifyDisabledReason,
  notifyErrorMessage,
  notifyHistoryHeadline,
  noteRevealClass,
  numberSubPoints,
  runPostReadyNotify,
  showAddSubPoint,
  showWithdrawalLine,
  subComposerRevealClass,
  tickCircle,
  withdrawalLine,
} from '@/components/pages/pcs/FeedbackLedger';
import type {
  FeedbackLedgerProps,
  NotificationRow,
  SubPointRow,
} from '@/components/pages/pcs/FeedbackLedger';
import { OVER_LIMIT_MESSAGE } from '@/components/comments/SlotComposer';
import type { Client } from '@srtdio/rpc';

// Node unit environment (no DOM renderer): walk the JSX returned by the
// hookless helpers and assert structure / classes, mirroring PcsTabs.test.tsx.

function flatten(node: ReactNode, out: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => flatten(child, out));
    return;
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) return;
  const el = node as ReactElement;
  out.push(el);
  flatten((el.props as { children?: ReactNode }).children, out);
}

function elements(tree: ReactNode): ReactElement[] {
  const out: ReactElement[] = [];
  flatten(tree, out);
  return out;
}

function clientWith(rpc: ReturnType<typeof vi.fn>): Client {
  return { rpc } as unknown as Client;
}

describe('ledger read shape', () => {
  it('selects every column the rows, accept state and note rendering need', () => {
    for (const column of [
      'ledger_seq',
      'ledger_batch_id',
      'resolution_note',
      'resolved_at',
      'resolved_by',
      'id',
      'body',
      'attachment_asset_ids',
      'author_user_id',
      'edited_at',
      'accepted_at',
      'accepted_by',
      'unaccepted_at',
      'unaccepted_by',
    ]) {
      expect(LEDGER_SELECT).toContain(column);
    }
  });

  it('selects the sub-point columns, including deleted_at for stable numbering', () => {
    for (const column of ['parent_comment_id', 'created_at', 'deleted_at', 'edited_at']) {
      expect(SUBPOINT_SELECT).toContain(column);
    }
  });

  it('selects the notification record columns', () => {
    for (const column of ['sent_by', 'checkpoint_count', 'sent_at']) {
      expect(NOTIFICATION_SELECT).toContain(column);
    }
  });
});

describe('isCheckpointAuthor (author-only gating)', () => {
  it('is true only for the author, never another client or a signed-out viewer', () => {
    expect(isCheckpointAuthor({ author_user_id: 'user-1' }, 'user-1')).toBe(true);
    expect(isCheckpointAuthor({ author_user_id: 'user-1' }, 'user-2')).toBe(false);
    expect(isCheckpointAuthor({ author_user_id: 'user-1' }, '')).toBe(false);
  });
});

describe('editedMarker (subtle edited indicator)', () => {
  it('renders nothing when the checkpoint has never been edited', () => {
    expect(editedMarker(null)).toBeNull();
  });

  it('renders a muted "edited" marker (text-fg-3) when edited_at is set', () => {
    const marker = editedMarker('2026-01-01T00:00:00.000Z');
    expect(marker).not.toBeNull();
    const els = elements(marker);
    const classNames = els.map((el) => (el.props as { className?: string }).className ?? '');
    expect(classNames.some((cls) => cls.includes('text-fg-3'))).toBe(true);
    for (const cls of classNames) {
      expect(cls).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(cls).not.toContain('dark:');
    }
    const text = els
      .flatMap((el) => {
        const child = (el.props as { children?: unknown }).children;
        return Array.isArray(child) ? child : [child];
      })
      .filter((c): c is string => typeof c === 'string')
      .join(' ');
    expect(text).toContain('edited');
  });
});

describe('ledgerCounts / ledgerProgress', () => {
  it('counts resolved rows against the total', () => {
    expect(
      ledgerCounts([
        { resolved_at: '2026-01-01T00:00:00.000Z' },
        { resolved_at: null },
        { resolved_at: '2026-01-02T00:00:00.000Z' },
      ]),
    ).toEqual({ resolved: 2, total: 3 });
    expect(ledgerCounts([])).toEqual({ resolved: 0, total: 0 });
  });

  it('formats the header progress as "X of N"', () => {
    expect(ledgerProgress(2, 5)).toBe('2 of 5');
    expect(ledgerProgress(0, 1)).toBe('0 of 1');
  });
});

describe('checkpointState / clientCircleInteractive', () => {
  it('maps resolved + accepted state to open / client_turn / confirmed', () => {
    expect(checkpointState({ resolved_at: null, accepted_at: null })).toBe('open');
    expect(checkpointState({ resolved_at: 't', accepted_at: null })).toBe('client_turn');
    expect(checkpointState({ resolved_at: 't', accepted_at: 't' })).toBe('confirmed');
    // An agency reopen (resolved_at back to null) drops even a previously
    // accepted point straight to open.
    expect(checkpointState({ resolved_at: null, accepted_at: 't' })).toBe('open');
  });

  it('makes the client circle interactive ONLY when resolved and unconfirmed', () => {
    const clientTurn = { resolved_at: 't', accepted_at: null };
    const confirmed = { resolved_at: 't', accepted_at: 't' };
    const openRow = { resolved_at: null, accepted_at: null };
    // Client, resolved + unconfirmed -> the circle is a live button.
    expect(clientCircleInteractive(clientTurn, true)).toBe(true);
    // Client, but confirmed or still open -> not interactive.
    expect(clientCircleInteractive(confirmed, true)).toBe(false);
    expect(clientCircleInteractive(openRow, true)).toBe(false);
    // Agency never drives the client circle.
    expect(clientCircleInteractive(clientTurn, false)).toBe(false);
  });
});

describe('showAddSubPoint (client-only, agency never)', () => {
  it('offers Add sub-point to the client on open and client_turn, never on a settled row', () => {
    expect(showAddSubPoint(true, 'open')).toBe(true);
    expect(showAddSubPoint(true, 'client_turn')).toBe(true);
    expect(showAddSubPoint(true, 'confirmed')).toBe(false);
  });

  it('never offers Add sub-point to the agency, in any state', () => {
    for (const state of ['open', 'client_turn', 'confirmed'] as const) {
      expect(showAddSubPoint(false, state)).toBe(false);
    }
  });
});

describe('showWithdrawalLine (record shown only after an undo)', () => {
  it('shows the line after a client undo (resolved, unconfirmed, unaccepted stamp)', () => {
    expect(showWithdrawalLine({ resolved_at: 't', accepted_at: null, unaccepted_at: 'u' })).toBe(
      true,
    );
  });

  it('hides the line after an agency un-tick or sub-point reopen (point returns to open)', () => {
    // resolved_at back to null even though the unaccepted stamp lingers.
    expect(showWithdrawalLine({ resolved_at: null, accepted_at: null, unaccepted_at: 'u' })).toBe(
      false,
    );
  });

  it('hides the line on a fresh resolve that was never accepted', () => {
    expect(showWithdrawalLine({ resolved_at: 't', accepted_at: null, unaccepted_at: null })).toBe(
      false,
    );
  });

  it('hides the line once the point is re-confirmed', () => {
    expect(showWithdrawalLine({ resolved_at: 't', accepted_at: 't', unaccepted_at: 'u' })).toBe(
      false,
    );
  });
});

describe('withdrawalLine copy', () => {
  it('names the withdrawing member when it resolves, stays anonymous otherwise', () => {
    expect(withdrawalLine('2026-01-01T00:00:00.000Z', 'Riya')).toContain('Withdrawn by Riya');
    expect(withdrawalLine('2026-01-01T00:00:00.000Z', null)).toContain('Confirmation withdrawn');
  });
});

describe('numberSubPoints (stable parentSeq.n numbering with gaps)', () => {
  function sub(id: string, createdAt: string, deletedAt: string | null): SubPointRow {
    return {
      id,
      body: `body ${id}`,
      author_user_id: 'user-1',
      parent_comment_id: 'cp',
      created_at: createdAt,
      deleted_at: deletedAt,
      edited_at: null,
    };
  }

  it('numbers by creation order across ALL sub-points and drops deleted rows', () => {
    const numbered = numberSubPoints(3, [
      sub('a', '2026-01-01T00:00:00.000Z', null),
      sub('b', '2026-01-02T00:00:00.000Z', null),
      sub('c', '2026-01-03T00:00:00.000Z', null),
    ]);
    expect(numbered.map((n) => n.label)).toEqual(['3.1', '3.2', '3.3']);
  });

  it('keeps the gap after a delete: numbers never shift under the client', () => {
    const numbered = numberSubPoints(3, [
      sub('a', '2026-01-01T00:00:00.000Z', null),
      sub('b', '2026-01-02T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
      sub('c', '2026-01-03T00:00:00.000Z', null),
    ]);
    // The middle one is soft-deleted: it is not rendered, and its number gap
    // remains, so the live rows stay 3.1 and 3.3.
    expect(numbered.map((n) => n.label)).toEqual(['3.1', '3.3']);
    expect(numbered.map((n) => n.row.id)).toEqual(['a', 'c']);
  });
});

describe('buildResolveArgs (comment_resolve wiring)', () => {
  it('carries the trimmed note as p_resolution_note only on a resolve', () => {
    expect(
      buildResolveArgs({ commentId: 'c1', resolved: true, note: '  ship it  ', traceId: 't1' }),
    ).toEqual({
      p_comment_id: 'c1',
      p_resolved: true,
      p_trace_id: 't1',
      p_resolution_note: 'ship it',
    });
  });

  it('omits a blank or absent note entirely', () => {
    expect(
      buildResolveArgs({ commentId: 'c1', resolved: true, note: '   ', traceId: 't1' }),
    ).toEqual({
      p_comment_id: 'c1',
      p_resolved: true,
      p_trace_id: 't1',
    });
    expect(buildResolveArgs({ commentId: 'c1', resolved: true, traceId: 't1' })).toEqual({
      p_comment_id: 'c1',
      p_resolved: true,
      p_trace_id: 't1',
    });
  });

  it('never sends a note on an untick, even when one is supplied', () => {
    expect(
      buildResolveArgs({ commentId: 'c2', resolved: false, note: 'stale note', traceId: 't2' }),
    ).toEqual({
      p_comment_id: 'c2',
      p_resolved: false,
      p_trace_id: 't2',
    });
  });
});

describe('note input constants', () => {
  it('caps the note at 500 chars with the agreed placeholder', () => {
    expect(MAX_NOTE_CHARS).toBe(500);
    expect(NOTE_PLACEHOLDER).toBe('What changed (optional, client sees this)');
  });
});

describe('friendly error copy', () => {
  it('maps a resolve invalid_payload (note too long) and permission codes', () => {
    expect(friendlyResolveError({ code: 'invalid_payload', message: 'invalid_payload' })).toContain(
      '500',
    );
    expect(friendlyResolveError({ code: 'forbidden_role', message: 'forbidden_role' })).toBe(
      'You do not have permission to make this change.',
    );
    expect(friendlyResolveError({ code: 'unknown', message: 'network down' })).toBe(
      'Something went wrong. Please try again.',
    );
  });

  it('maps an edit / sub-point create invalid_payload to the composer word-cap line', () => {
    expect(friendlyEditError('invalid_payload')).toBe(OVER_LIMIT_MESSAGE);
    expect(friendlyEditError('unknown')).toBe('Could not save. Please try again.');
  });

  it('maps checkpoint_accept failures, including the out-of-set invalid_stage message', () => {
    // invalid_stage is raised outside DOMAIN_ERROR_CODES, so it arrives as the raw
    // message under an 'unknown' code.
    expect(friendlyAcceptError({ code: 'unknown', message: 'invalid_stage' })).toBe(
      'This checkpoint is not ready to confirm yet.',
    );
    expect(friendlyAcceptError({ code: 'forbidden_role', message: 'forbidden_role' })).toBe(
      'Only the client can confirm a checkpoint.',
    );
    expect(friendlyAcceptError({ code: 'invalid_payload', message: 'invalid_payload' })).toBe(
      'This is not a checkpoint.',
    );
    expect(friendlyAcceptError({ code: 'unknown', message: 'network down' })).toBe(
      'Something went wrong. Please try again.',
    );
  });

  it('maps a sub-point delete failure to friendly copy', () => {
    expect(friendlyDeleteError({ code: 'forbidden_role', message: 'forbidden_role' })).toBe(
      'You do not have permission to delete this.',
    );
    expect(friendlyDeleteError({ code: 'unknown', message: 'oops' })).toBe(
      'Something went wrong. Please try again.',
    );
  });
});

describe('runPostReadyNotify (post_ready_notify wiring)', () => {
  it('invokes the proc with p_post_id and an explicit p_trace_id', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const result = await runPostReadyNotify(clientWith(rpc), {
      postId: 'post-1',
      traceId: 'trace-n',
    });
    expect(rpc).toHaveBeenCalledWith('post_ready_notify', {
      p_post_id: 'post-1',
      p_trace_id: 'trace-n',
    });
    expect(result).toEqual({ ok: true, data: undefined });
  });

  it('maps a raised domain code to itself (forbidden_role)', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'forbidden_role' } }));
    const result = await runPostReadyNotify(clientWith(rpc), { postId: 'p', traceId: 't' });
    expect(result).toEqual({
      ok: false,
      error: { code: 'forbidden_role', message: 'forbidden_role' },
    });
  });

  it('keeps the raw message for the ledger-specific raises outside DOMAIN_ERROR_CODES', async () => {
    for (const message of ['checkpoints_open', 'invalid_stage']) {
      const rpc = vi.fn(async () => ({ data: null, error: { message } }));
      const result = await runPostReadyNotify(clientWith(rpc), { postId: 'p', traceId: 't' });
      expect(result).toEqual({ ok: false, error: { code: 'unknown', message } });
    }
  });
});

describe('notify copy and gating', () => {
  it('maps checkpoints_open / forbidden_role / invalid_stage to friendly inline errors', () => {
    expect(notifyErrorMessage('checkpoints_open')).toBe(
      'Some checkpoints are still open. Resolve them all first.',
    );
    expect(notifyErrorMessage('forbidden_role')).toBe('Only agency members can send this.');
    expect(notifyErrorMessage('invalid_stage')).toBe('This post is not in review anymore.');
    expect(notifyErrorMessage('network down')).toBe(
      'Could not notify the client. Please try again.',
    );
  });

  it('states the open count as the disabled reason, pluralised, and null when clear', () => {
    expect(notifyDisabledReason(1)).toBe('Resolve 1 open checkpoint first.');
    expect(notifyDisabledReason(3)).toBe('Resolve 3 open checkpoints first.');
    expect(notifyDisabledReason(0)).toBeNull();
  });

  it('has the agreed button label', () => {
    expect(NOTIFY_LABEL).toBe("Tell client it's ready");
  });
});

describe('notification record (permanent, read from the table)', () => {
  function notif(id: string, sentAt: string, count: number): NotificationRow {
    return { id, sent_by: null, checkpoint_count: count, sent_at: sentAt };
  }

  it('renders every row: the newest prominent plus the full earlier history', () => {
    const rows = [
      notif('n3', '2026-03-01T00:00:00.000Z', 3),
      notif('n2', '2026-02-01T00:00:00.000Z', 2),
      notif('n1', '2026-01-01T00:00:00.000Z', 2),
    ];
    const view = buildNotificationView(rows, false);
    expect(view).not.toBeNull();
    expect(view!.latest.id).toBe('n3');
    // latest + earlier accounts for every row, none dropped.
    expect(view!.earlier.map((n) => n.id)).toEqual(['n2', 'n1']);
    expect(1 + view!.earlier.length).toBe(rows.length);
  });

  it('returns null when nothing has been sent', () => {
    expect(buildNotificationView([], true)).toBeNull();
  });

  it('phrases the headline for each side', () => {
    expect(notifyHistoryHeadline(true)).toBe('The agency told you this post is ready.');
    expect(notifyHistoryHeadline(false)).toBe('You told the client this post is ready.');
  });

  it('labels the checkpoint count, singular at one', () => {
    expect(checkpointCountLabel(1)).toBe('1 checkpoint');
    expect(checkpointCountLabel(3)).toBe('3 checkpoints');
  });
});

describe('motion (declared axes only)', () => {
  it('the tick check enters via opacity/translateY, never slide/rotate/scale', () => {
    for (const done of [true, false]) {
      const classNames = elements(tickCircle(done)).map(
        (el) => (el.props as { className?: string }).className ?? '',
      );
      const animated = classNames.find((cls) => cls.includes('transition-[opacity,transform]'))!;
      expect(animated).toBeDefined();
      expect(animated).toMatch(done ? /opacity-100/ : /opacity-0/);
      expect(animated).toMatch(/translate-y/);
      expect(animated).not.toMatch(/translate-x|rotate|scale/);
    }
  });

  it('fills the circle with the good token only when done', () => {
    const doneCircle = elements(tickCircle(true))[0]!;
    expect((doneCircle.props as { className: string }).className).toContain('bg-good');
    const openCircle = elements(tickCircle(false))[0]!;
    expect((openCircle.props as { className: string }).className).not.toContain('bg-good');
  });

  it('rings the live (client-turn) circle with the accent tokens, unfilled', () => {
    const live = elements(tickCircle(false, true))[0]!;
    const cls = (live.props as { className: string }).className;
    expect(cls).toContain('ring-accent');
    expect(cls).toContain('border-accent-line');
    expect(cls).not.toContain('bg-good');
  });

  it('reveals the note input via opacity/translateY only', () => {
    const entering = noteRevealClass(false);
    expect(entering).toContain('opacity-0');
    expect(entering).toContain('translate-y-1');
    const rested = noteRevealClass(true);
    expect(rested).toContain('opacity-100');
    expect(rested).toContain('translate-y-0');
    for (const cls of [entering, rested]) {
      expect(cls).toContain('transition-[opacity,transform]');
      expect(cls).not.toMatch(/translate-x|rotate|scale/);
    }
  });

  it('expands the sub-point composer via height/opacity only', () => {
    const collapsed = subComposerRevealClass(false);
    const open = subComposerRevealClass(true);
    expect(collapsed).toContain('max-h-0');
    expect(collapsed).toContain('opacity-0');
    expect(open).toContain('opacity-100');
    for (const cls of [collapsed, open]) {
      expect(cls).toContain('transition-[max-height,opacity]');
      expect(cls).not.toMatch(/translate|rotate|scale/);
    }
  });
});

function ledgerProps(overrides: Partial<FeedbackLedgerProps> = {}): FeedbackLedgerProps {
  return {
    workspaceId: 'ws-1',
    postId: 'post-1',
    postStage: 'review',
    viewerIsClient: false,
    viewerUserId: 'user-1',
    refreshSignal: 0,
    onMutated: () => {},
    ...overrides,
  };
}

describe('render (empty state)', () => {
  // The self-fetch runs in an effect that node SSR never flushes, so rows stay
  // empty here: this exercises the mounted component and the "return null when
  // there are no points" invariant. A populated card render needs a DOM runner
  // (not installed) or a fetch effect (skipped under SSR); noted as a follow-up.
  it('renders nothing when the post has no checkpoints', () => {
    expect(renderToStaticMarkup(<FeedbackLedger {...ledgerProps()} />)).toBe('');
  });
});
