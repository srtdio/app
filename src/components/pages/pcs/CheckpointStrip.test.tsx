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
  STRIP_SURFACE_CLASS,
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
import { PressableRow } from '@/components/ui/PressableRow';

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

describe('checkpointCounts (resolved of total, lifted to the page)', () => {
  it('counts every checkpoint whose resolved_at is not null against the total', () => {
    expect(
      checkpointCounts([{ resolved_at: 't' }, { resolved_at: null }, { resolved_at: 't' }]),
    ).toEqual({ resolved: 2, total: 3 });
    expect(checkpointCounts([])).toEqual({ resolved: 0, total: 0 });
  });
});

describe('chipState (fix 32: only Open and Resolved are visible)', () => {
  it('maps every DB state down to open / resolved', () => {
    expect(chipState({ resolved_at: null })).toBe('open');
    // Resolved, confirmed or not, is one visible state.
    expect(chipState({ resolved_at: 't' })).toBe('resolved');
    expect(chipState(row('a', 1, 't', 't'))).toBe('resolved');
    // An agency reopen drops even a previously accepted point straight to open.
    expect(chipState(row('b', 2, null, 't'))).toBe('open');
  });
});

describe('chipCircleClass (token treatment per visible state)', () => {
  it('resolved fills with the success fill and the on-colour ink token, never text-white', () => {
    const cls = chipCircleClass('resolved');
    expect(cls).toContain('bg-[var(--good-solid)]');
    expect(cls).toContain('text-accent-fg');
    expect(cls).not.toContain('text-white');
  });
  it('open uses the muted panel treatment, distinct from resolved', () => {
    const cls = chipCircleClass('open');
    expect(cls).toContain('bg-panel-2');
    expect(cls).not.toContain('good');
  });
  it('uses only design tokens: no hex, no dark: literal, no white literal', () => {
    for (const state of ['open', 'resolved'] as const) {
      const cls = chipCircleClass(state);
      expect(cls).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(cls).not.toContain('dark:');
      expect(cls).not.toMatch(/\bwhite\b/);
    }
  });
});

describe('checkpointChips', () => {
  // Deliberately out of read order to prove the render sorts.
  const rows = [
    row('c', 3, 't', 't'), // resolved (and accepted in the DB)
    row('a', 1, null, null), // open
    row('b', 2, 't', null), // resolved
  ];

  it('renders one chip per checkpoint in ledger_seq order regardless of read order', () => {
    const chips = checkpointChips(rows);
    expect(chips).toHaveLength(3);
    expect(chips.map((chip) => (chip.props as { ['aria-label']: string })['aria-label'])).toEqual([
      'Jump to checkpoint 1',
      'Jump to checkpoint 2',
      'Jump to checkpoint 3',
    ]);
  });

  it('every chip is a PressableRow button carrying a 44px minimum touch target', () => {
    for (const chip of checkpointChips(rows)) {
      expect(chip.type).toBe(PressableRow);
      const cls = (chip.props as { className: string }).className;
      expect(cls).toContain('min-h-[44px]');
      expect(cls).toContain('min-w-[44px]');
    }
  });

  it('shows the ledger_seq number and no glyph component on an open chip', () => {
    const open = checkpointChips([row('y', 5, null, null)])[0]!;
    expect(collectText(open)).toContain('5');
    expect(elements(open).some((el) => typeof el.type === 'function')).toBe(false);
  });

  it('shows a tick glyph and NOT the number on a resolved chip, accepted or not', () => {
    // The tick tracks resolved_at only; accepted_at never shows as its own state.
    for (const resolved of [row('a', 7, 't', null), row('x', 7, 't', 't')]) {
      const chip = checkpointChips([resolved])[0]!;
      expect(collectText(chip)).not.toContain('7');
      expect(elements(chip).some((el) => typeof el.type === 'function')).toBe(true);
    }
  });

  it('resolved chips: hollow tick until confirmed, filled once confirmed', () => {
    const chips = checkpointChips(rows); // ordered 1(open), 2(resolved), 3(resolved, accepted)
    const circleClass = (chip: ReactElement): string => {
      const inner = elements(chip).find((el) =>
        ((el.props as { className?: string }).className ?? '').includes('rounded-full'),
      );
      return (inner?.props as { className?: string }).className ?? '';
    };
    expect(circleClass(chips[0]!)).toContain('bg-panel-2');
    expect(circleClass(chips[1]!)).toContain('bg-transparent');
    expect(circleClass(chips[1]!)).toContain('border-good');
    expect(circleClass(chips[1]!)).toContain('text-good');
    expect(circleClass(chips[2]!)).toContain('bg-[var(--good-solid)]');
    expect(chipCircleClass('resolved', false)).not.toContain('good-solid');
  });

  it('applies the two visible states their circle treatment (open vs resolved)', () => {
    const chips = checkpointChips([
      row('a', 1, null, null),
      row('b', 2, 't', 't'),
      row('c', 3, 't', 't'),
    ]);
    const circleClass = (chip: ReactElement): string => {
      const inner = elements(chip).find((el) =>
        ((el.props as { className?: string }).className ?? '').includes('rounded-full'),
      );
      return (inner?.props as { className?: string }).className ?? '';
    };
    expect(circleClass(chips[0]!)).toContain('bg-panel-2');
    expect(circleClass(chips[1]!)).toContain('bg-[var(--good-solid)]');
    expect(circleClass(chips[2]!)).toBe(circleClass(chips[1]!));
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

describe('strip surface (sticky background matches its card)', () => {
  it('uses the comments card surface token, not the page background', () => {
    expect(STRIP_SURFACE_CLASS).toBe('bg-panel-2');
    expect(STRIP_SURFACE_CLASS).not.toContain('bg-bg');
  });
});
