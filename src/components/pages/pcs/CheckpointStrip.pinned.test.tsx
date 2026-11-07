// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The post screen's pinned block (phone page mode): the exit bar and the
// checkpoint progress row under it stay pinned while the document scrolls, and
// tapping a circle scrolls to and flashes that checkpoint (flashNode, real).

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
vi.mock('@/lib/supabase', () => ({ supabase: { from: () => ({}) } }));

import { HeaderBar } from '@/components/ui/HeaderBar';
import { CheckpointProgress } from '@/components/pages/pcs/CheckpointStrip';
import type { SharedCheckpointRow } from '@/components/pages/pcs/CheckpointStrip';
import { commentDomId, LiveCheckpointsContext } from '@/components/comments/Comments';
import type { LiveCheckpoint } from '@/components/comments/Comments';
import { applyScrollMode, SAFE_TOP_BAR_CLASS } from '@/lib/scroll-mode';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROWS: SharedCheckpointRow[] = [
  { id: 'c-1', ledger_seq: 1, resolved_at: null, accepted_at: null, deleted_at: null },
  { id: 'c-2', ledger_seq: 2, resolved_at: 't', accepted_at: 't', deleted_at: null },
];

/** The post page's shape: pinned bar + slot, then the feed whose list mounts the row. */
function Page({ live }: { live: ReadonlyMap<string, LiveCheckpoint> }) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  return (
    <>
      <HeaderBar
        title="Post"
        onBack={() => {}}
        compact
        pinned
        className={SAFE_TOP_BAR_CLASS}
        below={<div data-checkpoint-pin-slot="" ref={setSlot} />}
      />
      <div data-feed="">
        <LiveCheckpointsContext.Provider value={live}>
          <CheckpointProgress
            workspaceId="ws-1"
            postId="post-1"
            refreshSignal={0}
            checkpoints={ROWS}
            target={slot}
          />
        </LiveCheckpointsContext.Provider>
        {ROWS.map((row) => (
          <div key={row.id} id={commentDomId(row.id)}>
            point {row.ledger_seq}
          </div>
        ))}
      </div>
    </>
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  // Phone page mode: the document is the scroller.
  applyScrollMode('page');
  const main = document.createElement('main');
  document.body.appendChild(main);
  host = main;
  root = createRoot(main);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  applyScrollMode('locked');
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('pinned exit block (phone page mode)', () => {
  it('the bar and the progress row sit in one sticky block and stay there on scroll', () => {
    act(() => root?.render(<Page live={new Map()} />));
    const block = host?.querySelector<HTMLElement>('[data-header-pin]');
    expect(block).not.toBeNull();
    const cls = block?.className.split(' ') ?? [];
    expect(cls).toContain('sticky');
    expect(cls).toContain('top-0');
    expect(cls).toContain('lit-header');
    // The row was portalled out of the feed into the pinned slot under the bar.
    const row = block?.querySelector('[data-checkpoint-progress-row]');
    expect(row).not.toBeNull();
    expect(host?.querySelector('[data-feed] [data-checkpoint-progress-row]')).toBeNull();
    expect(row?.querySelector('[data-checkpoint-progress]')?.textContent).toBe('1 of 2 resolved');
    // No floating strip of its own any more.
    expect(host?.querySelector('[data-checkpoint-strip]')).toBeNull();

    // The document scrolls (page mode): nothing unpins or remounts.
    document.documentElement.scrollTop = 1_500;
    act(() => window.dispatchEvent(new Event('scroll')));
    expect(host?.querySelector('[data-header-pin]')).toBe(block);
    expect(block?.querySelector('[data-checkpoint-progress-row]')).toBe(row);
    expect(block?.querySelector('[data-header-bar]')).not.toBeNull();
  });

  it('the live list state repaints a circle in the same render', () => {
    act(() => root?.render(<Page live={new Map()} />));
    const tick = (): string | null | undefined =>
      host
        ?.querySelector('[aria-label="Jump to checkpoint 1"] [data-chip-tick]')
        ?.getAttribute('data-chip-tick');
    expect(tick()).toBe('open');
    const resolved = new Map([['c-1', { resolved_at: 'now', accepted_at: null }]]);
    act(() => root?.render(<Page live={resolved} />));
    expect(tick()).toBe('hollow');
  });

  it('tapping a circle scrolls to that checkpoint and flashes it', () => {
    vi.useFakeTimers();
    const scrollTo = vi.fn();
    // The document scroller: jsdom has no layout, so give it room to scroll.
    const doc = document.documentElement;
    Object.defineProperty(doc, 'scrollHeight', { value: 4_000, configurable: true });
    Object.defineProperty(doc, 'clientHeight', { value: 700, configurable: true });
    doc.scrollTo = scrollTo as unknown as typeof doc.scrollTo;
    const intoView = vi.fn();
    Element.prototype.scrollIntoView = intoView;

    act(() => root?.render(<Page live={new Map()} />));
    const circle = host?.querySelector<HTMLButtonElement>('[aria-label="Jump to checkpoint 2"]');
    expect(circle).not.toBeNull();
    act(() => circle?.click());

    const target = document.getElementById(commentDomId('c-2'));
    expect(target?.classList.contains('lit-selected')).toBe(true);
    // Scrolled to it, by its scroller or by scrollIntoView.
    expect(scrollTo.mock.calls.length + intoView.mock.calls.length).toBeGreaterThan(0);
    // The flash ends on its own.
    act(() => vi.advanceTimersByTime(1_300));
    expect(target?.classList.contains('lit-selected')).toBe(false);
    // The other checkpoint is untouched.
    const other = document.getElementById(commentDomId('c-1'));
    expect(other?.classList.contains('lit-selected')).toBe(false);
  });
});
