// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckpointChipRow } from '@/components/pages/pcs/CheckpointStrip';

// Fix 32 on the strip: no "settled" counter, no client banner, only two chip
// looks (open / resolved) and resolved ink is a token (never text-white). The
// row has no surface of its own (it sits in the pinned block under the bar).

const { rows } = vi.hoisted(() => ({ rows: { current: [] as CheckpointChipRow[] } }));

vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-test' }));
vi.mock('@/lib/chat/use-chat-attachments', () => ({
  useChatAttachments: () => ({ presignEnabled: false, presignCache: {} }),
  useCommentAttachments: () => ({
    canAttach: false,
    presignEnabled: false,
    presignCache: null,
    uploadFile: async () => ({ ok: false, message: 'off' }),
  }),
}));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        is: () => chain,
        order: async () => ({ data: rows.current, error: null }),
      };
      return chain;
    },
  },
}));

import { CheckpointProgress } from '@/components/pages/pcs/CheckpointStrip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('CheckpointProgress (fix 32)', () => {
  it('circles plus "{n} of {m} resolved": no settled counter, no banner, token ink', async () => {
    rows.current = [
      { id: 'a', ledger_seq: 1, resolved_at: null, accepted_at: null },
      { id: 'b', ledger_seq: 2, resolved_at: 't', accepted_at: null },
      { id: 'c', ledger_seq: 3, resolved_at: 't', accepted_at: 't' },
    ];
    const onCounts = vi.fn();
    act(() => {
      root?.render(
        <CheckpointProgress
          workspaceId="ws-1"
          postId="post-1"
          refreshSignal={0}
          onCounts={onCounts}
        />,
      );
    });
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });

    const strip = host?.querySelector('[data-checkpoint-progress-row]');
    expect(strip).not.toBeNull();
    const text = host?.textContent ?? '';
    expect(text).not.toContain('2/3');
    // The one progress line beside the chips: "{n} of {m} resolved".
    expect(host?.querySelector('[data-checkpoint-progress]')?.textContent).toBe('2 of 3 resolved');
    expect(text).not.toMatch(/settled|ready for your check|Confirmed/);
    expect(host?.innerHTML ?? '').not.toContain('settled');

    expect(strip?.className).not.toContain('bg-bg');
    expect(host?.innerHTML ?? '').not.toContain('text-white');
    expect(host?.innerHTML ?? '').toContain('text-accent-fg');

    // Counts still lift to the page (resolved = resolved_at set).
    expect(onCounts).toHaveBeenLastCalledWith({ resolved: 2, total: 3 });
  });
});
