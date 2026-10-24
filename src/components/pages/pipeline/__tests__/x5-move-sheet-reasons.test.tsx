// X5 fix 3 (FT18), revised by post flow C fix 39: the sheet lists only the
// allowed moves (no blocked rows); moveBlockedReason words a blocked board
// drop ("{Stage} posts can move to {allowed}."); an unknown role shows no actions; a failed role read says
// "Couldn't check your access." with Retry, never the role line.
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { MoveSheetView, type MoveSheetViewProps } from '@/components/pages/pipeline/MoveSheet';
import { PressableRow } from '@/components/ui/PressableRow';
import { GATE_IDLE, createApproveGate } from '@/components/pages/pipeline/approve-gate';
import { APPROVE_ROLE_BLOCKED, moveBlockedReason } from '@/components/pages/pipeline/stage-meta';
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
  return all(tree).filter(
    (el) => el.type === PressableRow && 'data-move-action' in (el.props as object),
  );
}

function actionOf(row: ReactElement): string {
  return (row.props as { 'data-move-action': string })['data-move-action'];
}

describe('X5 move sheet reasons and role states', () => {
  it('owner moving a Review post: no Draft row and no blocked-reason rows (allowed moves only)', () => {
    const tree = sheet({});
    const list = rows(tree);
    expect(list.map(actionOf)).toEqual(['approved', 'parked', 'rejected']);
    expect(list.some((row) => text(row).startsWith('Draft'))).toBe(false);
    expect(all(tree).some((el) => text(el).includes('Not allowed from'))).toBe(false);
    for (const row of list) expect((row.props as { disabled?: boolean }).disabled).toBeFalsy();
  });

  it('a blocked drop names where the post can go for this role, or that only approvers approve', () => {
    expect(moveBlockedReason(null, 'review', 'approved')).toBe(APPROVE_ROLE_BLOCKED);
    expect(moveBlockedReason(null, 'draft', 'approved')).toBe('Only approvers can approve.');
    expect(moveBlockedReason('client', 'review', 'parked')).toBe(
      'Review posts can move to Approved or Rejected.',
    );
    expect(moveBlockedReason('owner', 'draft', 'rejected')).toBe(
      'Draft posts can move to Review or Parked.',
    );
    expect(moveBlockedReason('owner', 'rejected', 'approved')).toBe(
      'Rejected posts can move to Review.',
    );
  });

  it('while the role is unknown no action shows and none blames the role', () => {
    // Even a role that would allow moves lists none until the read is ready.
    const tree = sheet({ role: 'owner', roleStatus: 'loading' });
    const all_ = all(tree);
    expect(all_.some((el) => text(el) === ROLE_READ_PENDING)).toBe(true);
    expect(rows(tree)).toHaveLength(0);
    expect(all_.some((el) => text(el).includes(APPROVE_ROLE_BLOCKED))).toBe(false);
  });

  it('a failed role read shows the plain line and a Retry that re-reads', () => {
    const onRetryRole = vi.fn();
    const tree = sheet({ role: null, roleStatus: 'error', onRetryRole });
    const elements = all(tree);
    expect(elements.some((el) => text(el) === ROLE_READ_ERROR)).toBe(true);
    for (const row of rows(tree)) expect(text(row)).not.toContain(APPROVE_ROLE_BLOCKED);
    const retry = elements.find(
      (el) =>
        text(el) === 'Retry' && typeof (el.props as { onClick?: unknown }).onClick === 'function',
    )!;
    (retry.props as { onClick: () => void }).onClick();
    expect(onRetryRole).toHaveBeenCalledTimes(1);
  });
});
