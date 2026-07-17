import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import {
  LEDGER_SELECT,
  MAX_NOTE_CHARS,
  NOTE_PLACEHOLDER,
  NOTIFY_LABEL,
  buildResolveArgs,
  friendlyEditError,
  friendlyResolveError,
  ledgerCounts,
  ledgerProgress,
  markPostNotified,
  noteRevealClass,
  notifyDisabledReason,
  notifyErrorMessage,
  runPostReadyNotify,
  tickCircle,
  wasPostNotified,
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
  it('selects every column the rows and note rendering need', () => {
    for (const column of [
      'ledger_seq',
      'ledger_batch_id',
      'resolution_note',
      'resolved_at',
      'resolved_by',
      'id',
      'body',
      'attachment_asset_ids',
    ]) {
      expect(LEDGER_SELECT).toContain(column);
    }
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

  it('maps a checkpoint edit invalid_payload to the composer word-cap line', () => {
    expect(friendlyEditError('invalid_payload')).toBe(OVER_LIMIT_MESSAGE);
    expect(friendlyEditError('unknown')).toBe('Could not save the edit. Please try again.');
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

  it('remembers a notified post for the session (UI-only)', () => {
    const postId = `post-${Math.random().toString(36).slice(2)}`;
    expect(wasPostNotified(postId)).toBe(false);
    markPostNotified(postId);
    expect(wasPostNotified(postId)).toBe(true);
    expect(wasPostNotified('some-other-post')).toBe(false);
  });
});

describe('motion (opacity/translateY only)', () => {
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
});
