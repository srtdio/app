import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { MoveSheetView } from '@/components/pages/pipeline/MoveSheet';
import { ApproveConfirm } from '@/components/ui/ApproveConfirm';
import { OnBehalfApproveSheet } from '@/components/ui/OnBehalfApproveSheet';
import { Sheet } from '@/components/ui/Sheet';
import {
  GATE_IDLE,
  createApproveGate,
  type GateState,
  type MoveOptions,
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

type Move = (postId: string, toStage: Stage, options?: MoveOptions) => void;

/** A real gate over a local state, with a spy as the page's move handler. */
function harness(): {
  gate: ReturnType<typeof createApproveGate>;
  move: ReturnType<typeof vi.fn<Move>>;
  state: () => GateState;
} {
  let state = GATE_IDLE;
  const move = vi.fn<Move>();
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

/** The move sheet's own Sheet inside the view's fragment (the on-behalf sheet sits beside it). */
function sheetOf(tree: ReactElement | null): ReactElement {
  const all: ReactElement[] = [];
  collect(tree, all);
  const sheet = all.find((el) => el.type === Sheet);
  expect(sheet).toBeDefined();
  return sheet!;
}

/** The on-behalf sheet beside the move sheet, if this role gets one. */
function onBehalfOf(tree: ReactElement | null): ReactElement | undefined {
  const all: ReactElement[] = [];
  collect(tree, all);
  return all.find((el) => el.type === OnBehalfApproveSheet);
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

function render(
  h: ReturnType<typeof harness>,
  post: PipelinePost,
  busy = false,
  role: string | null = 'client',
): ReactElement {
  const tree = MoveSheetView({
    open: true,
    post,
    onClose: () => {},
    busy,
    ...view(h, role),
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

/** The footer's approve confirm props, or null when the sheet has no footer (X only). */
function confirmOf(tree: ReactElement): ConfirmProps | null {
  const footer = (sheetOf(tree).props as { footer?: ReactElement }).footer;
  return footer !== undefined && footer.type === ApproveConfirm
    ? (footer.props as ConfirmProps)
    : null;
}

/** Every text node the confirm block renders. */
function confirmText(props: ConfirmProps): string[] {
  const all: ReactElement[] = [];
  collect(ApproveConfirm(props), all);
  return all
    .map((el) => (el.props as { children?: ReactNode }).children)
    .filter((child): child is string => typeof child === 'string');
}

describe('MoveSheet approve confirm (client)', () => {
  it('T1: picking Approved opens the confirm and does not move', () => {
    const h = harness();
    click(row(render(h, makePost('review')), 'approved'));
    expect(h.move).not.toHaveBeenCalled();
    const tree = render(h, makePost('review'));
    expect(confirmOf(tree)).not.toBeNull();
    // The rows give way to the confirm, as the chat sheet swaps its footer.
    expect(row(tree, 'rejected')).toBeUndefined();
  });

  it('T2: Back, the X, backdrop and Escape (Sheet onClose) send nothing', () => {
    const h = harness();
    const onClose = vi.fn();
    click(row(render(h, makePost('review')), 'approved'));
    const tree = MoveSheetView({
      open: true,
      post: makePost('review'),
      onClose,
      ...view(h, 'client'),
    });
    confirmOf(tree as ReactElement)?.onBack();
    expect(h.state()).toEqual(GATE_IDLE);
    expect(confirmOf(render(h, makePost('review')))).toBeNull();
    // The X, backdrop and Escape all route to the Sheet's onClose: the page's close.
    click(row(render(h, makePost('review')), 'approved'));
    const open = MoveSheetView({
      open: true,
      post: makePost('review'),
      onClose,
      ...view(h, 'client'),
    });
    (sheetOf(open).props as { onClose: () => void }).onClose();
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
      const tree = render(h, makePost('review'), false, 'agency');
      click(row(tree, stage));
      expect(h.move).toHaveBeenCalledWith('p1', stage);
      expect(confirmOf(render(h, makePost('review')))).toBeNull();
    }
  });

  it('T6: the confirm asks once with the target date, never repeats the header title, omits slides', () => {
    const h = harness();
    const dated = { ...makePost('review'), target_date: '2026-10-02T06:30:00Z' };
    click(row(render(h, dated), 'approved'));
    const withDate = confirmOf(render(h, dated));
    expect(withDate).toMatchObject({ postTitle: null, mediaCount: null, targetDate: 'Oct 2' });
    expect(confirmText(withDate as ConfirmProps)).toContain('Approve this post, for Oct 2?');
    expect(confirmText(withDate as ConfirmProps).join(' ')).not.toContain('A post');
    expect(confirmText(withDate as ConfirmProps).join(' ')).not.toMatch(/\b[A-Z]{2,}-\d+\b/);
    const undated = confirmOf(render(h, makePost('review')));
    expect(undated?.targetDate).toBe('');
    expect(confirmText(undated as ConfirmProps)).toContain('Approve this post?');
    // The title stays in the header.
    expect((sheetOf(render(h, dated)).props as { title: string }).title).toBe('A post');
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

  it('agency Approve on their behalf opens the on-behalf sheet; a client keeps the plain confirm', () => {
    const agency = harness();
    agency.gate.request('p1', 'approved');
    const agencyTree = MoveSheetView({
      open: true,
      post: makePost('review'),
      onClose: () => {},
      ...view(agency, 'agency'),
      brand: 'Zomato',
      approvers: [{ userId: 'u-client', name: 'Meera Shah' }],
    });
    const behalf = onBehalfOf(agencyTree);
    expect(behalf).toBeDefined();
    expect(behalf!.props).toMatchObject({
      open: true,
      brand: 'Zomato',
      approvers: [{ userId: 'u-client', name: 'Meera Shah' }],
    });
    // The move sheet steps aside while the on-behalf sheet is up, with no plain confirm.
    expect((sheetOf(agencyTree).props as { open: boolean }).open).toBe(false);
    expect(confirmOf(agencyTree)).toBeNull();
    // No on-behalf line anywhere: the picker replaces it.
    const all: ReactElement[] = [];
    collect(agencyTree, all);
    expect(all.some((el) => 'data-approve-on-behalf' in (el.props as object))).toBe(false);

    const client = harness();
    client.gate.request('p1', 'approved');
    const clientTree = MoveSheetView({
      open: true,
      post: makePost('review'),
      onClose: () => {},
      ...view(client, 'client'),
    });
    expect(onBehalfOf(clientTree)).toBeUndefined();
    expect(confirmOf(clientTree)).not.toBeNull();
  });

  it('the on-behalf Approve moves once with the picked approver; Cancel sends nothing', () => {
    const h = harness();
    h.gate.request('p1', 'approved');
    const tree = MoveSheetView({
      open: true,
      post: makePost('review'),
      onClose: () => {},
      ...view(h, 'agency'),
      approvers: [{ userId: 'u-client', name: 'Meera Shah' }],
    });
    const props = onBehalfOf(tree)!.props as {
      onCancel: () => void;
      onConfirm: (id: string | undefined) => void;
    };
    props.onConfirm('u-client');
    props.onConfirm('u-client');
    expect(h.move).toHaveBeenCalledOnce();
    expect(h.move).toHaveBeenCalledWith('p1', 'approved', { onBehalfOf: 'u-client' });

    const cancelled = harness();
    cancelled.gate.request('p1', 'approved');
    const again = MoveSheetView({
      open: true,
      post: makePost('review'),
      onClose: () => {},
      ...view(cancelled, 'agency'),
    });
    (onBehalfOf(again)!.props as { onCancel: () => void }).onCancel();
    expect(cancelled.state()).toEqual(GATE_IDLE);
    expect(cancelled.move).not.toHaveBeenCalled();
  });

  it('Parked and Rejected offer "Send for review"', () => {
    expect(rows('parked', 'agency')).toEqual([{ to: 'review', label: 'Send for review' }]);
    expect(rows('rejected', 'agency').map((r) => r.label)).toEqual(['Send for review']);
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
    expect((sheetOf(tree).props as { title: string }).title).toBe(
      'A very long post title that should wrap',
    );
  });

  it('closes with the X only: no footer and no Cancel button', () => {
    const tree = sheet('review');
    expect((sheetOf(tree).props as { footer?: unknown }).footer).toBeUndefined();
    const all: ReactElement[] = [];
    collect(tree, all);
    const texts = all.map((el) => (el.props as { children?: unknown }).children);
    expect(texts).not.toContain('Cancel');
  });
});
