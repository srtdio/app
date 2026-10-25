import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import {
  DECISION_BAR_SPACE_PX,
  decisionBarOrder,
  decisionBarSpace,
  PostDecisionBar,
  PostDecisionRow,
  SEND_AGAIN_LABEL,
  type DecisionModel,
} from '@/components/pages/pcs/PostDecisionBar';
import { visibleStageActions } from '@/components/pages/pcs/stage-actions';

// T12 / FN8 / flow B 30 / 33: the decision row, phone bar and laptop row.
// Hookless trees, walked in node.

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

function all(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement[] = [];
  collect(tree, out);
  return out as ReactElement<Record<string, unknown>>[];
}

function buttons(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  return all(tree).filter((el) => typeof el.type === 'function' && 'variant' in el.props);
}

/** A button's visible words (its string children, icons skipped). */
function label(el: ReactElement<Record<string, unknown>>): string {
  const children = el.props.children;
  const parts = Array.isArray(children) ? children : [children];
  return parts.filter((part): part is string => typeof part === 'string').join('');
}

function approver(role: string, onPick = vi.fn()): DecisionModel {
  return { kind: 'approver', actions: visibleStageActions('review', role), onPick };
}

describe('30. approver row: Reject, Approve, same on phone and laptop', () => {
  it('reads Reject, Approve in that order (no Comment); Reject is secondary with bad ink, Approve the one success', () => {
    for (const tree of [
      PostDecisionBar({ model: approver('client'), busy: false, error: null }),
      PostDecisionRow({ model: approver('client'), busy: false, error: null }),
    ]) {
      const row = buttons(tree);
      expect(row.map(label)).toEqual(['Reject', 'Approve']);
      expect(row.map(label)).not.toContain('Comment');
      expect(all(tree).some((el) => 'data-decision-comment' in el.props)).toBe(false);
      const [reject, approve] = row;
      expect(reject?.props.variant).toBe('secondary');
      expect(String(reject?.props.className)).toContain('text-bad');
      expect(approve?.props.variant).toBe('success');
      expect(row.filter((b) => b.props.variant === 'success')).toHaveLength(1);
      for (const b of row) expect(b.props.size).toBeUndefined();
    }
  });

  it('Reject and Approve report their targets', () => {
    const onPick = vi.fn();
    const row = buttons(
      PostDecisionRow({ model: approver('client', onPick), busy: false, error: null }),
    );
    (row[0]?.props.onClick as () => void)();
    (row[1]?.props.onClick as () => void)();
    expect(onPick.mock.calls).toEqual([['rejected'], ['approved']]);
  });

  it('the phone bar is fixed above the safe area, below md only; the laptop row is inline', () => {
    const bar = PostDecisionBar({
      model: approver('client'),
      busy: false,
      error: null,
    }) as ReactElement<{ className: string }>;
    expect(bar.props.className).toContain('fixed');
    expect(bar.props.className).toContain('pb-[max(12px,env(safe-area-inset-bottom))]');
    expect(bar.props.className).toContain('md:hidden');
    const row = PostDecisionRow({
      model: approver('client'),
      busy: false,
      error: null,
    }) as ReactElement<{ className: string }>;
    expect(row.props.className).not.toContain('fixed');
    expect(DECISION_BAR_SPACE_PX).toBeGreaterThanOrEqual(68);
  });

  it('in a sheet the same bar fills the host footer, which already pins and pads it', () => {
    const bar = PostDecisionBar({
      model: approver('client'),
      busy: false,
      error: null,
      placement: 'footer',
    }) as ReactElement<{ className: string; 'data-decision-bar': string }>;
    expect(bar.props['data-decision-bar']).toBe('');
    expect(bar.props.className).toBe('w-full');
    expect(buttons(bar).map(label)).toEqual(['Reject', 'Approve']);
  });

  it('decisionBarOrder: Reject first, Approve last, others between', () => {
    const ordered = decisionBarOrder(visibleStageActions('review', 'agency'));
    expect(ordered.map((a) => a.to)).toEqual(['rejected', 'parked', 'approved']);
  });

  it('renders nothing with no model and no error', () => {
    expect(PostDecisionBar({ model: null, busy: false, error: null })).toBeNull();
    expect(PostDecisionRow({ model: null, busy: false, error: null })).toBeNull();
  });

  it('renders nothing for an approver with no moves (no lone Comment bar)', () => {
    const model: DecisionModel = { kind: 'approver', actions: [], onPick: vi.fn() };
    expect(PostDecisionBar({ model, busy: false, error: null })).toBeNull();
  });
});

describe('33. creator: one main button', () => {
  it('"Send for review again" is live with no helper line; disabled only while busy (open comments never block)', () => {
    const onPress = vi.fn();
    const model: DecisionModel = {
      kind: 'creator',
      label: SEND_AGAIN_LABEL,
      disabled: false,
      helper: null,
      onPress,
    };
    const tree = PostDecisionBar({ model, busy: false, error: null });
    const row = buttons(tree);
    expect(row).toHaveLength(1);
    expect(label(row[0]!)).toBe('Send for review again');
    expect(row[0]?.props.variant).toBe('primary');
    expect(row[0]?.props.disabled).toBe(false);
    expect(all(tree).find((el) => el.props['data-decision-helper'] === '')).toBeUndefined();
    expect(
      all(tree).some(
        (el) => typeof el.props.children === 'string' && /Resolve/.test(el.props.children),
      ),
    ).toBe(false);
    (row[0]?.props.onClick as () => void)();
    expect(onPress).toHaveBeenCalledOnce();

    const inFlight = buttons(PostDecisionRow({ model, busy: true, error: null }));
    expect(inFlight[0]?.props.disabled).toBe(true);
  });

  it('never offers a primary Approve to a creator (31: it lives in the ⋯ sheet)', () => {
    const tree = PostDecisionRow({
      model: {
        kind: 'creator',
        label: 'Send for review',
        disabled: false,
        helper: null,
        onPress: () => {},
      },
      busy: false,
      error: null,
    });
    expect(buttons(tree).map(label)).toEqual(['Send for review']);
  });
});

describe('41. a failed tap shows once, inside the row that was tapped', () => {
  it('renders the plain-words error once as role=alert, and reserves room for it on phone', () => {
    const tree = PostDecisionBar({
      model: approver('client'),
      busy: false,
      error: "Couldn't do that. Try again.",
    });
    const alerts = all(tree).filter((el) => el.props.role === 'alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.props.children).toBe("Couldn't do that. Try again.");
    expect(decisionBarSpace(approver('client'), 'x')).toBeGreaterThan(
      decisionBarSpace(approver('client'), null),
    );
  });
});
