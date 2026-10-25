import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';

// The page's import graph pulls the real agora-chat browser SDK. Mock it so
// importing the hookless rail and confirm in node never touches browser globals.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
// The page's contexts and media query, stubbed so its first (loading) paint
// renders in node; effects never run under renderToStaticMarkup.
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'w1', workspaceKey: 'GBL', workspaces: [] }),
}));
vi.mock('@/lib/session-context', () => ({ useSession: () => ({ session: null }) }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 't1' }));
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => false,
}));

import { PcsApproveConfirm, PostDetailPage } from '@/components/pages/PostDetailPage';
import { PostDecisionRow } from '@/components/pages/pcs/PostDecisionBar';
import { visibleStageActions } from '@/components/pages/pcs/stage-actions';
import {
  GATE_IDLE,
  createApproveGate,
  type GateState,
} from '@/components/pages/pipeline/approve-gate';
import { ApproveConfirm } from '@/components/ui/ApproveConfirm';
import type { Stage } from '@srtdio/posts';

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

function collect(node: ReactNode, found: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, found));
    return;
  }
  if (typeof node !== 'object' || node === null || !('props' in node)) return;
  found.push(node);
  collect((node.props as { children?: ReactNode }).children, found);
}

/** The decision row's buttons for a role and stage, wired as the page wires them: through the gate. */
function rail(h: ReturnType<typeof harness>, stage: Stage, role: string): ReactElement[] {
  const all: ReactElement[] = [];
  collect(
    PostDecisionRow({
      model: {
        kind: 'approver',
        actions: visibleStageActions(stage, role),
        onPick: (to) => h.gate.request('p1', to),
      },
      busy: false,
      error: null,
    }),
    all,
  );
  return all.filter((el) => typeof (el.props as { onClick?: unknown }).onClick === 'function');
}

function press(buttons: ReactElement[], label: string): void {
  const button = buttons.find((el) => (el.props as { children?: ReactNode }).children === label);
  expect(button).toBeDefined();
  (button?.props as { onClick: () => void }).onClick();
}

type ConfirmProps = Parameters<typeof ApproveConfirm>[0];

function sheet(
  h: ReturnType<typeof harness>,
  over: Partial<Parameters<typeof PcsApproveConfirm>[0]> = {},
): ReactElement {
  return PcsApproveConfirm({
    gate: h.gate,
    gateState: h.state(),
    mediaCount: 3,
    targetDate: 'Oct 2',
    busy: false,
    error: null,
    ...over,
  });
}

function confirmOf(el: ReactElement): ConfirmProps {
  // Spec C1: the confirm sits in the sheet body (no empty band, no footer).
  expect((el.props as { footer?: unknown }).footer).toBeUndefined();
  const body = (el.props as { children: ReactElement }).children;
  expect(body.type).toBe(ApproveConfirm);
  return body.props as ConfirmProps;
}

function question(props: ConfirmProps): string {
  const all: ReactElement[] = [];
  collect(ApproveConfirm(props), all);
  const first = all.find((el) => el.type === 'p');
  return (first?.props as { children: string }).children;
}

describe('PCS approve confirm', () => {
  it('T1: Approve opens the confirm and does not call the transition', () => {
    const h = harness();
    expect((sheet(h).props as { open: boolean }).open).toBe(false);
    press(rail(h, 'review', 'client'), 'Approve');
    expect(h.move).not.toHaveBeenCalled();
    expect((sheet(h).props as { open: boolean }).open).toBe(true);
  });

  it('T2: Back and the Sheet close (button, backdrop, Escape) send nothing', () => {
    const h = harness();
    press(rail(h, 'review', 'client'), 'Approve');
    confirmOf(sheet(h)).onBack();
    expect(h.state()).toEqual(GATE_IDLE);
    press(rail(h, 'review', 'client'), 'Approve');
    (sheet(h).props as { onClose: () => void }).onClose();
    expect(h.state()).toEqual(GATE_IDLE);
    expect(h.move).not.toHaveBeenCalled();
  });

  it('T3: Confirm calls the transition once with the same args as the old direct call', () => {
    const h = harness();
    press(rail(h, 'review', 'client'), 'Approve');
    confirmOf(sheet(h)).onConfirm();
    expect(h.move).toHaveBeenCalledOnce();
    expect(h.move).toHaveBeenCalledWith('p1', 'approved');
  });

  it('T4: a double tap sends once; Confirm disables in flight and re-arms after a failure', () => {
    const h = harness();
    press(rail(h, 'review', 'client'), 'Approve');
    const props = confirmOf(sheet(h));
    props.onConfirm();
    props.onConfirm();
    expect(h.move).toHaveBeenCalledOnce();
    expect(confirmOf(sheet(h)).busy).toBe(true);
    // The page settles a failed approve: the sheet stays open with the error.
    h.gate.settle();
    const failed = confirmOf(sheet(h, { error: 'Could not approve.' }));
    expect(failed.busy).toBe(false);
    expect(failed.error).toBe('Could not approve.');
    expect((sheet(h).props as { open: boolean }).open).toBe(true);
    // The page's own in-flight flag also disables it.
    expect(confirmOf(sheet(h, { busy: true })).busy).toBe(true);
  });

  it('T5: Reject, Park and Send for review call the transition at once, no confirm', () => {
    const cases: [Stage, string, string, Stage][] = [
      ['review', 'client', 'Reject', 'rejected'],
      ['review', 'admin', 'Park', 'parked'],
      ['draft', 'admin', 'Send for review', 'review'],
    ];
    for (const [stage, role, label, to] of cases) {
      const h = harness();
      press(rail(h, stage, role), label);
      expect(h.move).toHaveBeenCalledWith('p1', to);
      expect((sheet(h).props as { open: boolean }).open).toBe(false);
    }
  });

  it('T6 / C1: "Approve this post?", then "{n} slides · due {date}", parts omitted when unknown', () => {
    const h = harness();
    press(rail(h, 'review', 'client'), 'Approve');
    expect((sheet(h).props as { title: string }).title).toBe('Approve this post?');
    expect(question(confirmOf(sheet(h)))).toBe('3 slides · due Oct 2');
    expect(question(confirmOf(sheet(h, { mediaCount: 1 })))).toBe('1 slide · due Oct 2');
    expect(question(confirmOf(sheet(h, { mediaCount: null })))).toBe('due Oct 2');
    expect(confirmOf(sheet(h)).mode).toBe('summary');
  });

  it('C1: the confirm never names the post title, never a KEY-N code', () => {
    const h = harness();
    press(rail(h, 'review', 'client'), 'Approve');
    const confirm = confirmOf(sheet(h));
    expect(confirm.postTitle).toBeNull();
    expect(question(confirm)).not.toMatch(/\b[A-Z]{2,}-\d+\b/);
    expect((sheet(h).props as { title: string }).title).not.toMatch(/\b[A-Z]{2,}-\d+\b/);
  });

  it('T7 / spec B8: one summary line, no title line above it', () => {
    const h = harness();
    press(rail(h, 'review', 'client'), 'Approve');
    const el = sheet(h);
    expect((el.props as { open: boolean }).open).toBe(true);
    const all: ReactElement[] = [];
    collect(ApproveConfirm(confirmOf(el)), all);
    expect(all.filter((n) => n.type === 'p')).toHaveLength(1);
    // The guided tour key rides the Approve button itself.
    expect(confirmOf(el).induction).toBeDefined();
    confirmOf(el).onConfirm();
    expect(h.move).toHaveBeenCalledWith('p1', 'approved');
  });

  it('T8: the approve confirm carries no on-behalf line (that is its own sheet now)', () => {
    const h = harness();
    press(rail(h, 'review', 'client'), 'Approve');
    const all: ReactElement[] = [];
    collect(ApproveConfirm(confirmOf(sheet(h))), all);
    const texts = all.map((n) => String((n.props as { children?: unknown }).children ?? ''));
    expect(texts.some((t) => t.includes('on their behalf'))).toBe(false);
  });

  it('T9: agency Reject from review and from approved moves at once', () => {
    for (const stage of ['review', 'approved'] as Stage[]) {
      const h = harness();
      press(rail(h, stage, 'agency'), 'Reject');
      expect(h.move).toHaveBeenCalledWith('p1', 'rejected');
    }
  });
});

describe('PostDetailPage embedded', () => {
  function paint(embedded: boolean): string {
    return renderToStaticMarkup(
      <StaticRouter location="/posts/p1?comment=c1">
        <PostDetailPage postId="p1" {...(embedded ? { embedded: true } : {})} />
      </StaticRouter>,
    );
  }

  it('embedded renders no page header and no Back button', () => {
    const html = paint(true);
    expect(html).toContain('Loading post');
    expect(html).not.toContain('h-14');
    expect(html).not.toContain('aria-label="Back"');
  });

  it('non-embedded keeps the h-14 header with Back', () => {
    const html = paint(false);
    expect(html).toContain('Loading post');
    expect(html).toContain('flex items-center gap-3 h-14 px-4 md:px-6 border-b border-border');
    expect(html).toContain('aria-label="Back"');
  });

  it('embedded writes no ?tab= (or strips ?comment=): every URL write is gated', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./PostDetailPage.tsx', import.meta.url)),
      'utf8',
    );
    // Exactly one write: the ?comment= strip (replace). Pin / highlight taps
    // never touch the URL (flow B: no tabs, no history entries).
    expect(src.match(/setSearchParams\(/g)).toHaveLength(1);
    expect(src).toContain('setSearchParams(next, { replace: true });');
    expect(src).toMatch(/useEffect\(\(\) => \{\n\s+if \(embedded\) return;\n\s+const comment/);
    // Every hard navigation to the pipeline goes through leave().
    expect(src.match(/navigate\('\/pipeline'\)/g)).toHaveLength(1);
  });

  it('embedded: the host can own the action sheet open state and add Open in pipeline', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./PostDetailPage.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('const actionsOpen = actionsOpenProp ?? ownActionsOpen;');
    expect(src).toContain('onActionsOpenChange?.(next);');
    expect(src).toContain('{...(onOpenInPipeline !== undefined ? { onOpenInPipeline } : {})}');
    // A host open while the sheet cannot mount closes at once (never pops open later).
    expect(src).toContain(
      '!firstPaintPending && !notFound && !loadError && detail !== null && !readOnly;',
    );
    expect(src).toContain(
      'if (actionsOpenProp === true && !sheetMountable) onActionsOpenChange?.(false);',
    );
    // One sheet: the page mounts exactly one PostActionSheet.
    expect(src.match(/<PostActionSheet/g)).toHaveLength(1);
  });
});
