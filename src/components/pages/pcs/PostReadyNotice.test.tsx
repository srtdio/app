import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// PostReadyNotice calls useNewTrace at the top; mock the trace hook so it renders
// to static markup with no provider tree, mirroring the former ledger test.
vi.mock('@/lib/trace-context', () => ({
  useNewTrace: () => () => 'trace-test',
}));

import {
  PostReadyNotice,
  NOTIFICATION_SELECT,
  NOTIFY_LABEL,
  buildNotificationView,
  checkpointCountLabel,
  notifyDisabledReason,
  notifyErrorMessage,
  notifyHistoryHeadline,
  runPostReadyNotify,
} from '@/components/pages/pcs/PostReadyNotice';
import type { NotificationRow, PostReadyNoticeProps } from '@/components/pages/pcs/PostReadyNotice';
import type { Client } from '@srtdio/rpc';

function clientWith(rpc: ReturnType<typeof vi.fn>): Client {
  return { rpc } as unknown as Client;
}

describe('notification read shape', () => {
  it('selects the notification record columns', () => {
    for (const column of ['sent_by', 'checkpoint_count', 'sent_at']) {
      expect(NOTIFICATION_SELECT).toContain(column);
    }
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

  it('keeps the raw message for raises outside DOMAIN_ERROR_CODES', async () => {
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
    expect(notifyErrorMessage('network down')).toBe('Could not notify the client. Please try again.');
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

function noticeProps(overrides: Partial<PostReadyNoticeProps> = {}): PostReadyNoticeProps {
  return {
    workspaceId: 'ws-1',
    postId: 'post-1',
    postStage: 'review',
    viewerIsClient: false,
    openCount: 0,
    refreshSignal: 0,
    onMutated: () => {},
    ...overrides,
  };
}

describe('send control gating (agency, in review)', () => {
  // The history read runs in an effect node SSR never flushes, so no record shows
  // here; these assert the synchronous send-control gating.
  // The send label carries an apostrophe SSR escapes to an entity, so assert on
  // an entity-free slice of NOTIFY_LABEL rather than the raw string.
  const SEND_LABEL_FRAGMENT = 'Tell client it';

  it('shows the send control with a count reason while checkpoints remain open', () => {
    const html = renderToStaticMarkup(<PostReadyNotice {...noticeProps({ openCount: 2 })} />);
    expect(html).toContain(SEND_LABEL_FRAGMENT);
    // The real disabled attribute (React renders boolean true as disabled="").
    expect(html).toContain('disabled=""');
    expect(html).toContain('Resolve 2 open checkpoints first.');
  });

  it('offers the send control with no reason once no checkpoints remain open', () => {
    const html = renderToStaticMarkup(<PostReadyNotice {...noticeProps({ openCount: 0 })} />);
    expect(html).toContain(SEND_LABEL_FRAGMENT);
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('Resolve');
  });

  it('renders nothing for the client until a send lands in history', () => {
    // Client sees no send control; history is empty under SSR (effect not flushed).
    expect(
      renderToStaticMarkup(<PostReadyNotice {...noticeProps({ viewerIsClient: true })} />),
    ).toBe('');
  });
});
