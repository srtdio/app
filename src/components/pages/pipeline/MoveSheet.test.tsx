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
import { stageLabel } from '@/components/pages/pipeline/stage-meta';
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
  refLabel: string;
  targetDate: string;
  role: string | null;
} {
  return { gate: h.gate, gateState: h.state(), refLabel: 'GBL-1', targetDate: 'Oct 2', role };
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

/** The label string carried by a target button (the stage name span). */
function labelOf(button: ReactElement): string | undefined {
  const inner: ReactElement[] = [];
  collect((button.props as { children?: ReactNode }).children, inner);
  for (const el of inner) {
    const child = (el.props as { children?: ReactNode }).children;
    if (typeof child === 'string' && STAGES.some((s) => stageLabel(s) === child)) {
      return child;
    }
  }
  return undefined;
}

function targetRows(source: Stage, busy = false): { label: string; disabled: boolean }[] {
  const tree = MoveSheetView({
    open: true,
    post: makePost(source),
    onClose: () => {},
    busy,
    ...view(harness()),
  });
  const all: ReactElement[] = [];
  collect(tree, all);
  return all
    .filter((el) => el.type === 'button')
    .map((button) => ({
      label: labelOf(button) ?? '',
      disabled: Boolean((button.props as { disabled?: boolean }).disabled),
    }))
    .filter((row) => row.label !== '');
}

describe('MoveSheet', () => {
  it('renders one row per OTHER stage with the current stage omitted', () => {
    for (const source of STAGES) {
      const rows = targetRows(source);
      expect(rows.map((r) => r.label).sort()).toEqual(
        STAGES.filter((s) => s !== source)
          .map(stageLabel)
          .sort(),
      );
    }
  });

  it('enables legal targets and disables the rest per the transition map (draft)', () => {
    const rows = targetRows('draft');
    const enabled = rows
      .filter((r) => !r.disabled)
      .map((r) => r.label)
      .sort();
    const disabled = rows
      .filter((r) => r.disabled)
      .map((r) => r.label)
      .sort();
    // draft -> review, parked are legal; approved, rejected are not.
    expect(enabled).toEqual([stageLabel('parked'), stageLabel('review')].sort());
    expect(disabled).toEqual([stageLabel('approved'), stageLabel('rejected')].sort());
    // The enabled set matches the canTransition mirror exactly.
    for (const row of rows) {
      const stage = STAGES.find((s) => stageLabel(s) === row.label)!;
      expect(!row.disabled).toBe(canTransition('draft', stage));
    }
  });

  it('enables only the legal target per the transition map (parked)', () => {
    const rows = targetRows('parked');
    const enabled = rows
      .filter((r) => !r.disabled)
      .map((r) => r.label)
      .sort();
    const disabled = rows
      .filter((r) => r.disabled)
      .map((r) => r.label)
      .sort();
    // parked -> review only.
    expect(enabled).toEqual([stageLabel('review')]);
    expect(disabled).toEqual(
      [stageLabel('draft'), stageLabel('approved'), stageLabel('rejected')].sort(),
    );
  });

  it('a legal row calls onMove with the post id and target stage', () => {
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
    const reviewRow = all.find(
      (el) => el.type === 'button' && labelOf(el) === stageLabel('review'),
    )!;
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
  return all.find((el) => el.type === 'button' && labelOf(el) === stageLabel(stage));
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

  it('T6: the confirm names KEY-N and the target date when set, and omits slides', () => {
    const h = harness();
    const dated = { ...makePost('review'), target_date: '2026-10-02T06:30:00Z' };
    click(row(render(h, dated), 'approved'));
    const withDate = confirmOf(render(h, dated));
    expect(withDate).toMatchObject({ refLabel: 'GBL-1', mediaCount: null, targetDate: 'Oct 2' });
    expect(confirmText(withDate as ConfirmProps)).toContain('Approve GBL-1, for Oct 2?');
    const undated = confirmOf(render(h, makePost('review')));
    expect(undated?.targetDate).toBe('');
    expect(confirmText(undated as ConfirmProps)).toContain('Approve GBL-1?');
  });
});

describe('MoveSheet targets per role', () => {
  function rows(source: Stage, role: string | null): { label: string; disabled: boolean }[] {
    const tree = MoveSheetView({
      open: true,
      post: makePost(source),
      onClose: () => {},
      ...view(harness(), role),
    });
    const all: ReactElement[] = [];
    collect(tree, all);
    return all
      .filter((el) => el.type === 'button')
      .map((button) => ({
        label: labelOf(button) ?? '',
        disabled: Boolean((button.props as { disabled?: boolean }).disabled),
      }))
      .filter((row) => row.label !== '');
  }

  it('client sees only Approved and Rejected rows (no Park, no Back to review)', () => {
    const labels = rows('review', 'client').map((r) => r.label);
    expect(labels).toEqual([stageLabel('approved'), stageLabel('rejected')]);
    expect(rows('review', 'client').every((r) => !r.disabled)).toBe(true);
    const fromApproved = rows('approved', 'client');
    expect(fromApproved.map((r) => r.label)).toEqual([stageLabel('rejected')]);
    expect(rows('parked', 'client').every((r) => r.disabled)).toBe(true);
  });

  it('agency sees every other stage with the legal ones enabled', () => {
    const enabled = rows('review', 'agency')
      .filter((r) => !r.disabled)
      .map((r) => r.label);
    expect(enabled).toEqual([stageLabel('approved'), stageLabel('parked'), stageLabel('rejected')]);
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
