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
vi.mock('@/lib/use-media-query', () => ({ useMediaQuery: () => false }));

import { PcsApproveConfirm, PostDetailPage, StageButtons } from '@/components/pages/PostDetailPage';
import { ON_BEHALF_CONFIRM_LINE, visibleStageActions } from '@/components/pages/pcs/stage-actions';
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

/** The rail for a client in review, wired as the page wires it: through the gate. */
function rail(h: ReturnType<typeof harness>, stage: Stage, role: string): ReactElement[] {
  const all: ReactElement[] = [];
  collect(
    StageButtons({
      actions: visibleStageActions(stage, role),
      transitioning: false,
      onPick: (to) => h.gate.request('p1', to),
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
    refLabel: 'GBL-4',
    format: 'carousel',
    title: 'Diwali teaser',
    mediaCount: 3,
    targetDate: 'Oct 2',
    busy: false,
    error: null,
    onBehalf: false,
    ...over,
  });
}

function confirmOf(el: ReactElement): ConfirmProps {
  const footer = (el.props as { footer: ReactElement }).footer;
  expect(footer.type).toBe(ApproveConfirm);
  return footer.props as ConfirmProps;
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

  it('T6: slide count from the loaded gallery and the target date when set; omitted when not', () => {
    const h = harness();
    press(rail(h, 'review', 'client'), 'Approve');
    expect(question(confirmOf(sheet(h)))).toBe('Approve GBL-4, all 3 slides, for Oct 2?');
    expect(question(confirmOf(sheet(h, { mediaCount: null })))).toBe('Approve GBL-4, for Oct 2?');
    expect(question(confirmOf(sheet(h, { mediaCount: null, targetDate: '' })))).toBe(
      'Approve GBL-4?',
    );
    expect((sheet(h).props as { title: string }).title).toBe('GBL-4 · Carousel');
  });

  it('T7: agency approves with the same two-step confirm plus the on-behalf line', () => {
    const h = harness();
    press(rail(h, 'review', 'agency'), 'Approve');
    expect(h.move).not.toHaveBeenCalled();
    const el = sheet(h, { onBehalf: true });
    expect((el.props as { open: boolean }).open).toBe(true);
    const all: ReactElement[] = [];
    collect((el.props as { children: ReactNode }).children, all);
    const texts = all.map((n) => (n.props as { children?: unknown }).children);
    expect(texts).toContain(ON_BEHALF_CONFIRM_LINE);
    confirmOf(el).onConfirm();
    expect(h.move).toHaveBeenCalledWith('p1', 'approved');
  });

  it('T8: the client confirm carries no on-behalf line', () => {
    const h = harness();
    press(rail(h, 'review', 'client'), 'Approve');
    const all: ReactElement[] = [];
    collect((sheet(h).props as { children: ReactNode }).children, all);
    const texts = all.map((n) => (n.props as { children?: unknown }).children);
    expect(texts).not.toContain(ON_BEHALF_CONFIRM_LINE);
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
    // Exactly two writes: the ?comment= strip and the flashTo tab switch.
    expect(src.match(/setSearchParams\(/g)).toHaveLength(2);
    expect(src).toMatch(/useEffect\(\(\) => \{\n\s+if \(embedded\) return;\n\s+const comment/);
    expect(src).toContain('if (!embedded && !isDesktop && activeTab !== tab) {');
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
      'const sheetMountable = !loading && !notFound && detail !== null && !readOnly;',
    );
    expect(src).toContain(
      'if (actionsOpenProp === true && !sheetMountable) onActionsOpenChange?.(false);',
    );
    // One sheet: the page mounts exactly one PostActionSheet.
    expect(src.match(/<PostActionSheet/g)).toHaveLength(1);
  });
});
