// X5 fix 3 (FT18): stage-matrix rows say "Not allowed from {stage}"; role rows
// keep the role reason; an unknown role is busy; a failed role read says
// "Couldn't check your access." with Retry, never the role line.
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { MoveSheetView, type MoveSheetViewProps } from '@/components/pages/pipeline/MoveSheet';
import { GATE_IDLE, createApproveGate } from '@/components/pages/pipeline/approve-gate';
import { ROLE_BLOCKED_REASON, moveBlockedReason } from '@/components/pages/pipeline/stage-meta';
import { ROLE_READ_ERROR, ROLE_READ_PENDING } from '@/components/pages/pipeline/member-role';
import { x5Post } from './x5-fixtures';

function isElement(node: ReactNode): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node;
}

function all(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    node.forEach((child) => all(child, out));
    return out;
  }
  if (!isElement(node)) return out;
  out.push(node);
  const props = node.props as { children?: ReactNode; footer?: ReactNode };
  all(props.footer, out);
  all(props.children, out);
  return out;
}

function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (!isElement(node)) return '';
  return text((node.props as { children?: ReactNode }).children);
}

function sheet(overrides: Partial<MoveSheetViewProps>): ReactElement {
  let state = GATE_IDLE;
  const gate = createApproveGate({
    move: vi.fn(),
    read: () => state,
    write: (next) => {
      state = next;
    },
  });
  return MoveSheetView({
    open: true,
    post: x5Post({ stage: 'review' }),
    onClose: () => {},
    gate,
    gateState: GATE_IDLE,
    targetDate: '',
    role: 'owner',
    ...overrides,
  })!;
}

function rows(tree: ReactElement): ReactElement[] {
  return all(tree).filter((el) => el.type === 'button' && 'aria-disabled' in (el.props as object));
}

describe('X5 move sheet reasons and role states', () => {
  it('owner moving a Review post: the Draft row says "Not allowed from Review"', () => {
    const draft = rows(sheet({})).find((row) => text(row).startsWith('Draft'))!;
    expect(text(draft)).toContain('Not allowed from Review');
    expect((draft.props as { disabled: boolean }).disabled).toBe(true);
  });

  it('a row the map allows but the role does not keeps the role reason', () => {
    expect(moveBlockedReason(null, 'review', 'approved')).toBe(ROLE_BLOCKED_REASON);
    expect(moveBlockedReason('client', 'review', 'parked')).toBe(ROLE_BLOCKED_REASON);
    // The stage map wins over the role.
    expect(moveBlockedReason(null, 'draft', 'approved')).toBe('Not allowed from Draft');
  });

  it('while the role is unknown every row is busy and none blames the role', () => {
    const tree = sheet({ role: null, roleStatus: 'loading' });
    const all_ = all(tree);
    expect(all_.some((el) => text(el) === ROLE_READ_PENDING)).toBe(true);
    for (const row of rows(tree)) {
      expect((row.props as { disabled: boolean }).disabled).toBe(true);
      expect(text(row)).not.toContain(ROLE_BLOCKED_REASON);
    }
  });

  it('a failed role read shows the plain line and a Retry that re-reads', () => {
    const onRetryRole = vi.fn();
    const tree = sheet({ role: null, roleStatus: 'error', onRetryRole });
    const elements = all(tree);
    expect(elements.some((el) => text(el) === ROLE_READ_ERROR)).toBe(true);
    for (const row of rows(tree)) expect(text(row)).not.toContain(ROLE_BLOCKED_REASON);
    const retry = elements.find(
      (el) =>
        text(el) === 'Retry' && typeof (el.props as { onClick?: unknown }).onClick === 'function',
    )!;
    (retry.props as { onClick: () => void }).onClick();
    expect(onRetryRole).toHaveBeenCalledTimes(1);
  });
});
