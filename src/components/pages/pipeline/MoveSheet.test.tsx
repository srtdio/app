import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { MoveSheetView } from '@/components/pages/pipeline/MoveSheet';
import { onBehalfConfirmLine } from '@/components/pages/pcs/stage-actions';
import { ApproveConfirm } from '@/components/ui/ApproveConfirm';
import {
  GATE_IDLE,
  createApproveGate,
  type GateState,
} from '@/components/pages/pipeline/approve-gate';
import { STAGE_TRANSITIONS, canTransition } from '@srtdio/posts';
import type { PipelinePost, Stage } from '@srtdio/posts';

const STAGES = Object.keys(STAGE_TRANSITIONS) as Stage[];

function makePost(stage: Stage): PipelinePost {
  return {
    id: 'p1',
    workspace_id: 'w',
    number: 1,
    title: 'A post',
    stage,
    platform: 'instagram',
    format: 'reel',
    origin: 'manual',
    legacy_author_name: null,
    caption: null,
    brief_id: null,
    bucket_id: null,
    owner_user_id: 'u',
    created_by: 'u',
    target_date: null,
    deleted_at: null,
    row_version: 1,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    stage_entered_at: '2026-01-01',
    approved_by: null,
    approved_on_behalf_of: null,
    approved_at: null,
    thumbnailAssetVersionId: null,
  };
}

/** A real gate over a local state, with a spy as the page's move handler. */
function harness(): {
  gate: ReturnType<typeof createApproveGate>;
  move: ReturnType<typeof vi.fn<(postId: string, toStage: Stage) => void>>;
  state: () => GateState;
} {
  let state = GATE_IDLE;
  const move = vi.fn<(postId: string, toStage: Stage) => void>();
  const gate = createApproveGate({
    move,
    read: () => state,
    write: (next) => {
      state = next;
    },
  });
  return { gate, move, state: () => state };
}

function view(
  h: ReturnType<typeof harness>,
  role: string | null = 'agency',
): {
  gate: ReturnType<typeof createApproveGate>;
  gateState: GateState;
  targetDate: string;
  role: string | null;
} {
  return { gate: h.gate, gateState: h.state(), targetDate: 'Oct 2', role };
}

function isElement(node: ReactNode): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node;
}

function collect(node: ReactNode, found: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, found));
    return;
  }
  if (!isElement(node)) return;
  found.push(node);
  collect((node.props as { children?: ReactNode }).children, found);
}

/** The target stage an action row moves to (its data-move-action), if it is one. */
function targetOf(button: ReactElement): Stage | undefined {
  return (button.props as { 'data-move-action'?: Stage })['data-move-action'];
}

/** The visible label of an action row (its first string span). */
function labelOf(button: ReactElement): string {
  const inner: ReactElement[] = [];
  collect((button.props as { children?: ReactNode }).children, inner);
  for (const el of inner) {
    const child = (el.props as { children?: ReactNode }).children;
    if (typeof child === 'string') return child;
  }
  return '';
}

function targetRows(
  source: Stage,
  busy = false,
  role: string | null = 'agency',
): { to: Stage; label: string; disabled: boolean }[] {
  const tree = MoveSheetView({
    open: true,
    post: makePost(source),
    onClose: () => {},
    busy,
    ...view(harness(), role),
  });
  const all: ReactElement[] = [];
  collect(tree, all);
  return all
    .filter((el) => el.type === 'button' && targetOf(el) !== undefined)
    .map((button) => ({
      to: targetOf(button)!,
      label: labelOf(button),
      disabled: Boolean((button.props as { disabled?: boolean }).disabled),
    }));
}

describe('MoveSheet', () => {
  it('renders only the allowed moves: never the current stage, never Draft', () => {
    for (const source of STAGES) {
      const rows = targetRows(source);
      expect(rows.map((r) => r.to)).toEqual(
        STAGES.filter((s) => s !== source && s !== 'draft' && canTransition(source, s)),
      );
      expect(rows.some((r) => r.to === 'draft' || r.to === source)).toBe(false);
    }
  });

  it('lists exactly the legal targets per the transition map (draft), all enabled', () => {
    const rows = targetRows('draft');
    // draft -> review, parked are legal; approved, rejected never show.
    expect(rows.map((r) => r.to)).toEqual(['review', 'parked']);
    expect(rows.every((r) => !r.disabled)).toBe(true);
    for (const row of rows) expect(canTransition('draft', row.to)).toBe(true);
  });

  it('lists only the legal target per the transition map (parked)', () => {
    const rows = targetRows('parked');
    // parked -> review only.
    expect(rows.map((r) => r.to)).toEqual(['review']);
    expect(rows[0]!.disabled).toBe(false);
  });

  it('a row calls onMove with the post id and target stage', () => {
    const h = harness();
    const onMove = h.move;
    const tree = MoveSheetView({
      open: true,
      post: makePost('draft'),
      onClose: () => {},
      ...view(h),
    });
    const all: ReactElement[] = [];
    collect(tree, all);
    const reviewRow = all.find((el) => el.type === 'button' && targetOf(el) === 'review')!;
    (reviewRow.props as { onClick: () => void }).onClick();
    expect(onMove).toHaveBeenCalledWith('p1', 'review');
  });

  it('disables every move target while busy (in-flight move), overriding legality', () => {
    const rows = targetRows('draft', true);
    expect(rows.length).toBeGreaterThan(0);
    // draft has legal targets (review, parked) that are enabled when idle; busy
    // disables them too. Fails if MoveSheet ignores the busy prop.
    expect(rows.every((row) => row.disabled)).toBe(true);
  });

  it('keeps legal targets enabled when not busy', () => {
    const rows = targetRows('draft', false);
    expect(rows.some((row) => !row.disabled)).toBe(true);
  });

  it('renders nothing when there is no post', () => {
    expect(
      MoveSheetView({ open: false, post: null, onClose: () => {}, ...view(harness()) }),
    ).toBeNull();
  });
});

type ConfirmProps = Parameters<typeof ApproveConfirm>[0];

function render(h: ReturnType<typeof harness>, post: PipelinePost, busy = false): ReactElement {
  const tree = MoveSheetView({
    open: true,
    post,
    onClose: () => {},
    busy,
    ...view(h),
    targetDate: post.target_date === null ? '' : 'Oct 2',
  });
  expect(tree).not.toBeNull();
  return tree as ReactElement;
}

function row(tree: ReactElement, stage: Stage): ReactElement | undefined {
  const all: ReactElement[] = [];
  collect(tree, all);
  return all.find((el) => el.type === 'button' && targetOf(el) === stage);
}

function click(el: ReactElement | undefined): void {
  expect(el).toBeDefined();
  (el?.props as { onClick: () => void }).onClick();
}

/** The footer's approve confirm props, or null when the footer is the Cancel button. */
function confirmOf(tree: ReactElement): ConfirmProps | null {
  const footer = (tree.props as { footer: ReactElement }).footer;
  return footer.type === ApproveConfirm ? (footer.props as ConfirmProps) : null;
}

/** Every text node the confirm block renders. */
function confirmText(props: ConfirmProps): string[] {
  const all: ReactElement[] = [];
  collect(ApproveConfirm(props), all);
  return all
    .map((el) => (el.props as { children?: ReactNode }).children)
    .filter((child): child is string => typeof child === 'string');
}

describe('MoveSheet approve confirm', () => {
  it('T1: picking Approved opens the confirm and does not move', () => {
    const h = harness();
    click(row(render(h, makePost('review')), 'approved'));
    expect(h.move).not.toHaveBeenCalled();
    const tree = render(h, makePost('review'));
    expect(confirmOf(tree)).not.toBeNull();
    // The rows give way to the confirm, as the chat sheet swaps its footer.
    expect(row(tree, 'rejected')).toBeUndefined();
  });

  it('T2: Back, Cancel, backdrop and Escape (Sheet onClose) send nothing', () => {
    const h = harness();
    const onClose = vi.fn();
    click(row(render(h, makePost('review')), 'approved'));
    const tree = MoveSheetView({ open: true, post: makePost('review'), onClose, ...view(h) });
    confirmOf(tree as ReactElement)?.onBack();
    expect(h.state()).toEqual(GATE_IDLE);
    expect(confirmOf(render(h, makePost('review')))).toBeNull();
    // Cancel, backdrop and Escape all route to the Sheet's onClose: the page's close.
    click(row(render(h, makePost('review')), 'approved'));
    const open = MoveSheetView({ open: true, post: makePost('review'), onClose, ...view(h) });
    (open as ReactElement).props.onClose();
    expect(onClose).toHaveBeenCalledOnce();
    expect(h.move).not.toHaveBeenCalled();
  });

  it('T3: Confirm moves exactly once with the same args as a direct move', () => {
    const h = harness();
    click(row(render(h, makePost('review')), 'approved'));
    confirmOf(render(h, makePost('review')))?.onConfirm();
    expect(h.move).toHaveBeenCalledOnce();
    expect(h.move).toHaveBeenCalledWith('p1', 'approved');
  });

  it('T4: a double tap on Confirm moves once, and Confirm disables while in flight', () => {
    const h = harness();
    click(row(render(h, makePost('review')), 'approved'));
    const first = confirmOf(render(h, makePost('review')));
    first?.onConfirm();
    first?.onConfirm();
    expect(h.move).toHaveBeenCalledOnce();
    expect(confirmOf(render(h, makePost('review')))?.busy).toBe(true);
    // A failed move (sheet still open) re-arms Confirm for one retry.
    h.gate.settle();
    expect(confirmOf(render(h, makePost('review')))?.busy).toBe(false);
  });

  it('T5: Rejected and Parked move at once with no confirm', () => {
    for (const stage of ['rejected', 'parked'] as const) {
      const h = harness();
      const tree = render(h, makePost('review'));
      click(row(tree, stage));
      expect(h.move).toHaveBeenCalledWith('p1', stage);
      expect(confirmOf(render(h, makePost('review')))).toBeNull();
    }
  });

  it('T6: the confirm names the post title and the target date when set, and omits slides', () => {
    const h = harness();
    const dated = { ...makePost('review'), target_date: '2026-10-02T06:30:00Z' };
    click(row(render(h, dated), 'approved'));
    const withDate = confirmOf(render(h, dated));
    expect(withDate).toMatchObject({ postTitle: 'A post', mediaCount: null, targetDate: 'Oct 2' });
    expect(confirmText(withDate as ConfirmProps)).toContain('Approve A post, for Oct 2?');
    expect(confirmText(withDate as ConfirmProps).join(' ')).not.toMatch(/\b[A-Z]{2,}-\d+\b/);
    const undated = confirmOf(render(h, makePost('review')));
    expect(undated?.targetDate).toBe('');
    expect(confirmText(undated as ConfirmProps)).toContain('Approve A post?');
  });
});

describe('MoveSheet targets per role', () => {
  function rows(source: Stage, role: string | null): { to: Stage; label: string }[] {
    return targetRows(source, false, role).map(({ to, label }) => ({ to, label }));
  }

  it('client sees only Approve and Reject (no Park, no Back to review)', () => {
    expect(rows('review', 'client')).toEqual([
      { to: 'approved', label: 'Approve' },
      { to: 'rejected', label: 'Reject' },
    ]);
    expect(targetRows('review', false, 'client').every((r) => !r.disabled)).toBe(true);
    expect(rows('approved', 'client').map((r) => r.to)).toEqual(['rejected']);
    // Nothing a client may do from Parked: no rows at all, never greyed ones.
    expect(rows('parked', 'client')).toEqual([]);
  });

  it('agency sees the legal moves only, approving on their behalf', () => {
    expect(rows('review', 'agency')).toEqual([
      { to: 'approved', label: 'Approve on their behalf' },
      { to: 'parked', label: 'Park' },
      { to: 'rejected', label: 'Reject' },
    ]);
  });

  it('agency approve confirm carries the on-behalf line; client confirm does not', () => {
    for (const [role, expected] of [
      ['agency', true],
      ['client', false],
    ] as [string, boolean][]) {
      const h = harness();
      h.gate.request('p1', 'approved');
      const tree = MoveSheetView({
        open: true,
        post: makePost('review'),
        onClose: () => {},
        ...view(h, role),
      });
      const all: ReactElement[] = [];
      collect(tree, all);
      const texts = all.map((el) => (el.props as { children?: unknown }).children);
      expect(texts.includes(onBehalfConfirmLine(null))).toBe(expected);
    }
  });
});

describe('W4 fix 9 (revised): MoveSheet has no blocked rows and is titled by the post', () => {
  function sheet(source: Stage, role: string | null = 'agency'): ReactElement {
    return MoveSheetView({
      open: true,
      post: { ...makePost(source), title: 'A very long post title that should wrap' },
      onClose: () => {},
      ...view(harness(), role),
    })!;
  }

  it('no row carries a blocked reason (blocked moves are left out, not greyed)', () => {
    for (const source of ['draft', 'parked'] as const) {
      const all: ReactElement[] = [];
      collect(sheet(source), all);
      expect(all.some((el) => 'data-blocked-reason' in (el.props as object))).toBe(false);
      const texts = all.map((el) => (el.props as { children?: unknown }).children);
      const blocked = texts.some((t) => typeof t === 'string' && t.startsWith('Not allowed from'));
      expect(blocked).toBe(false);
    }
  });

  it('the sheet title is the post title, not "Move post"', () => {
    const tree = sheet('review');
    expect((tree.props as { title: string }).title).toBe('A very long post title that should wrap');
  });
});
