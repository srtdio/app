import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import {
  DECISION_BAR_SPACE_PX,
  decisionBarOrder,
  PostDecisionBar,
} from '@/components/pages/pcs/PostDecisionBar';
import { visibleStageActions } from '@/components/pages/pcs/stage-actions';

// T12 / FN8: the phone decision bar. Hookless tree, walked in node.

function collect(node: ReactNode, out: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, out));
    return;
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) return;
  const el = node as ReactElement;
  out.push(el);
  collect((el.props as { children?: ReactNode }).children, out);
}

function buttons(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement[] = [];
  collect(tree, out);
  return out.filter(
    (el) => typeof el.type === 'function' && 'variant' in (el.props as object),
  ) as ReactElement<Record<string, unknown>>[];
}

describe('PostDecisionBar', () => {
  it('renders nothing for someone who cannot act on the stage', () => {
    expect(PostDecisionBar({ actions: [], transitioning: false, onPick: () => {} })).toBeNull();
    // An unknown role has no actions in review.
    expect(visibleStageActions('review', null)).toEqual([]);
  });

  it('Park / Reject / Approve for the agency in review: Approve is the one accent-filled button, last', () => {
    const actions = visibleStageActions('review', 'agency');
    const tree = PostDecisionBar({ actions, transitioning: false, onPick: () => {} });
    const all = buttons(tree);
    const labels = all.map((b) => b.props.children);
    expect(labels[labels.length - 1]).toBe('Approve');
    expect(labels).toContain('Reject');
    expect(labels).toContain('Park');
    const primary = all.filter((b) => b.props.variant === 'primary');
    expect(primary).toHaveLength(1);
    expect(primary[0]?.props.children).toBe('Approve');
    for (const b of all) expect(b.props.size).toBe('lg');
  });

  it('the client sees Reject and Approve only, and a tap reports the target', () => {
    const onPick = vi.fn();
    const tree = PostDecisionBar({
      actions: visibleStageActions('review', 'client'),
      transitioning: false,
      onPick,
    });
    const all = buttons(tree);
    expect(all.map((b) => b.props.children)).toEqual(['Reject', 'Approve']);
    (all[1]?.props.onClick as () => void)();
    expect(onPick).toHaveBeenCalledWith('approved');
  });

  it('sits above the safe area, phone only, and reserves room under the page', () => {
    const tree = PostDecisionBar({
      actions: visibleStageActions('review', 'client'),
      transitioning: false,
      onPick: () => {},
    }) as ReactElement<{ className: string }>;
    expect(tree.props.className).toContain('fixed');
    expect(tree.props.className).toContain('pb-[max(12px,env(safe-area-inset-bottom))]');
    expect(tree.props.className).toContain('md:hidden');
    expect(DECISION_BAR_SPACE_PX).toBeGreaterThanOrEqual(68);
  });

  it('decisionBarOrder keeps order and moves Approve to the end', () => {
    const ordered = decisionBarOrder(visibleStageActions('review', 'agency'));
    expect(ordered[ordered.length - 1]?.to).toBe('approved');
    expect(ordered.map((a) => a.to)).toEqual(['rejected', 'parked', 'approved']);
  });
});
