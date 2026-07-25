import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement, ReactNode } from 'react';

// CheckpointStrip transitively pulls the comment module (for commentDomId) and
// its provider-bound hooks; mock the two hook modules so the strip and its
// helpers import with no provider tree, mirroring the former ledger test. flashNode
// is mocked so a chip activation can be asserted without a DOM.
vi.mock('@/lib/trace-context', () => ({
  useNewTrace: () => () => 'trace-test',
}));
vi.mock('@/lib/chat/use-chat-attachments', () => ({
  useChatAttachments: () => ({ presignEnabled: false, presignCache: {} }),
}));
const flashNodeMock = vi.fn();
vi.mock('@/components/comments/flash-node', () => ({
  flashNode: (id: string) => flashNodeMock(id),
}));

import {
  CheckpointStrip,
  CHECKPOINT_SELECT,
  awaitingCount,
  checkpointChips,
  checkpointCounts,
  chipCircleClass,
  chipState,
} from '@/components/pages/pcs/CheckpointStrip';
import type {
  CheckpointChipRow,
  CheckpointStripProps,
} from '@/components/pages/pcs/CheckpointStrip';
import { commentDomId } from '@/components/comments/Comments';

// Node unit environment (no DOM renderer): walk the JSX the hookless helpers
// return and assert structure / classes, mirroring PcsTabs.test.tsx.
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
function collectText(tree: ReactNode): string {
  return elements(tree)
    .flatMap((el) => {
      const child = (el.props as { children?: unknown }).children;
      return Array.isArray(child) ? child : [child];
    })
    .filter((c): c is string | number => typeof c === 'string' || typeof c === 'number')
    .map(String)
    .join(' ');
}

function row(
  id: string,
  ledgerSeq: number,
  resolvedAt: string | null,
  acceptedAt: string | null,
): CheckpointChipRow {
  return { id, ledger_seq: ledgerSeq, resolved_at: resolvedAt, accepted_at: acceptedAt };
}

describe('chip read shape (narrowed to only what the chips need)', () => {
  it('selects the chip columns and never bodies, mentions or attachments', () => {
    for (const column of ['id', 'ledger_seq', 'resolved_at', 'accepted_at']) {
      expect(CHECKPOINT_SELECT).toContain(column);
    }
    for (const column of ['body', 'mention', 'attachment', 'resolution_note']) {
      expect(CHECKPOINT_SELECT).not.toContain(column);
    }
  });
});

describe('checkpointCounts (settled of total)', () => {
  it('counts every checkpoint whose resolved_at is not null against the total', () => {
    expect(
      checkpointCounts([{ resolved_at: 't' }, { resolved_at: null }, { resolved_at: 't' }]),
    ).toEqual({ resolved: 2, total: 3 });
    expect(checkpointCounts([])).toEqual({ resolved: 0, total: 0 });
  });
});

describe('chipState (derived from columns, never stored)', () => {
  it('maps resolved + accepted to open / awaiting / confirmed', () => {
    expect(chipState({ resolved_at: null, accepted_at: null })).toBe('open');
    expect(chipState({ resolved_at: 't', accepted_at: null })).toBe('awaiting');
    expect(chipState({ resolved_at: 't', accepted_at: 't' })).toBe('confirmed');
    // An agency reopen (resolved_at back to null) drops even a previously
    // accepted point straight to open.
    expect(chipState({ resolved_at: null, accepted_at: 't' })).toBe('open');
  });
});

describe('chipCircleClass (each state its own token treatment)', () => {
  it('confirmed fills with the success token', () => {
    expect(chipCircleClass('confirmed')).toContain('bg-good');
  });
  it('awaiting uses the accent-soft background with an accent border', () => {
    const cls = chipCircleClass('awaiting');
    expect(cls).toContain('bg-accent-soft');
    expect(cls).toContain('border-accent-line');
  });
  it('open uses the muted panel treatment, distinct from the other two', () => {
    const cls = chipCircleClass('open');
    expect(cls).toContain('bg-panel-2');
    expect(cls).not.toContain('bg-good');
    expect(cls).not.toContain('bg-accent-soft');
  });
  it('uses only design tokens: no hex, no dark: literal', () => {
    for (const state of ['open', 'awaiting', 'confirmed'] as const) {
      const cls = chipCircleClass(state);
      expect(cls).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(cls).not.toContain('dark:');
    }
  });
});

describe('awaitingCount (points awaiting the client)', () => {
  it('counts resolved-but-unconfirmed points only', () => {
    expect(
      awaitingCount([
        row('a', 1, 't', null), // awaiting
        row('b', 2, 't', 't'), // confirmed
        row('c', 3, null, null), // open
        row('d', 4, 't', null), // awaiting
      ]),
    ).toBe(2);
  });
});

describe('checkpointChips', () => {
  // Deliberately out of read order to prove the render sorts.
  const rows = [
    row('c', 3, 't', 't'), // confirmed
    row('a', 1, null, null), // open
    row('b', 2, 't', null), // awaiting
  ];

  it('renders one chip per checkpoint in ledger_seq order regardless of read order', () => {
    const chips = checkpointChips(rows);
    expect(chips).toHaveLength(3);
    expect(
      chips.map((chip) => (chip.props as { ['aria-label']: string })['aria-label']),
    ).toEqual(['Jump to checkpoint 1', 'Jump to checkpoint 2', 'Jump to checkpoint 3']);
  });

  it('every chip is a real button carrying a 44px minimum touch target', () => {
    for (const chip of checkpointChips(rows)) {
      expect(chip.type).toBe('button');
      const cls = (chip.props as { className: string }).className;
      expect(cls).toContain('min-h-[44px]');
      expect(cls).toContain('min-w-[44px]');
    }
  });

  it('shows the ledger_seq number and no glyph component on a non-confirmed chip', () => {
    const open = checkpointChips([row('y', 5, null, null)])[0]!;
    expect(collectText(open)).toContain('5');
    expect(elements(open).some((el) => typeof el.type === 'function')).toBe(false);
  });

  it('shows a tick glyph and NOT the number on a confirmed chip', () => {
    const confirmed = checkpointChips([row('x', 7, 't', 't')])[0]!;
    expect(collectText(confirmed)).not.toContain('7');
    // A component element (the tick glyph) stands in place of the number.
    expect(elements(confirmed).some((el) => typeof el.type === 'function')).toBe(true);
  });

  it('applies each of the three states its own circle treatment', () => {
    const chips = checkpointChips(rows); // ordered 1(open), 2(awaiting), 3(confirmed)
    const circleClass = (chip: ReactElement): string => {
      const inner = elements(chip).find((el) =>
        ((el.props as { className?: string }).className ?? '').includes('rounded-full'),
      );
      return (inner?.props as { className?: string }).className ?? '';
    };
    expect(circleClass(chips[0]!)).toContain('bg-panel-2');
    expect(circleClass(chips[1]!)).toContain('bg-accent-soft');
    expect(circleClass(chips[2]!)).toContain('bg-good');
  });

  it('activating a chip flashes that checkpoint by its comment DOM id', () => {
    flashNodeMock.mockClear();
    const chips = checkpointChips([row('cp-42', 1, null, null)]);
    (chips[0]!.props as { onClick: () => void }).onClick();
    expect(flashNodeMock).toHaveBeenCalledWith(commentDomId('cp-42'));
    expect(commentDomId('cp-42')).toBe('comment-cp-42');
  });

  it('renders no checkpoint body text anywhere: only seq digits and the tick', () => {
    const text = checkpointChips([row('a', 1, null, null), row('b', 2, 't', 't')])
      .map(collectText)
      .join(' ');
    // No prose words in the strip output; the feed owns every body.
    expect(text).not.toMatch(/[A-Za-z]{3,}/);
  });

  it('no chip element translates, rotates or scales', () => {
    for (const chip of checkpointChips([row('a', 1, 't', null)])) {
      for (const el of elements(chip)) {
        const cls = (el.props as { className?: string }).className ?? '';
        expect(cls).not.toMatch(/translate|rotate|scale/);
      }
    }
  });
});

function stripProps(overrides: Partial<CheckpointStripProps> = {}): CheckpointStripProps {
  return {
    workspaceId: 'ws-1',
    postId: 'post-1',
    viewerIsClient: false,
    refreshSignal: 0,
    ...overrides,
  };
}

describe('render (empty state)', () => {
  // The self-fetch runs in an effect node SSR never flushes, so rows stay empty:
  // this exercises the "return null when there are no checkpoints" invariant.
  it('renders nothing when the post has no checkpoints', () => {
    expect(renderToStaticMarkup(<CheckpointStrip {...stripProps()} />)).toBe('');
  });
});
