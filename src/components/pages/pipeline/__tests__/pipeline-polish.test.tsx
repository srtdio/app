// @vitest-environment jsdom
// Pipeline polish: the compact empty stage with no second New post, the move
// sheet's one-line rows and 2-line title, the 24px chip fade, and the 44x44
// sort and due buttons.
import { act, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// ActionMenu picks popover vs Sheet by width; the node env has no matchMedia.
vi.mock('@/lib/use-is-laptop', () => ({ useIsLaptop: () => true }));
import { EmptyState } from '@/components/ui/EmptyState';
import { Sheet } from '@/components/ui/Sheet';
import { StageEmpty } from '@/components/pages/pipeline/stage-meta';
import { chipRowMask } from '@/components/pages/pipeline/StageChips';
import { MoveSheetView } from '@/components/pages/pipeline/MoveSheet';
import { PipelineFeed } from '@/components/pages/pipeline/PipelineFeed';
import type { PresignCache } from '@/lib/asset-presign';
import {
  PipelineDateControl,
  PipelineSortControl,
  sortControlBody,
} from '@/components/pages/pipeline/PipelineSortControl';
import { GATE_IDLE, createApproveGate } from '@/components/pages/pipeline/approve-gate';
import { POST_SORT_DEFAULT } from '@/lib/list-sort';
import type { Stage } from '@srtdio/posts';
import { x5Post } from './x5-fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let desktop = false;

function mount(node: ReactElement): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

beforeEach(() => {
  window.matchMedia = vi.fn((query: string) => ({
    matches: desktop,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  desktop = false;
  document.body.innerHTML = '';
});

describe('Pipeline polish: empty stage', () => {
  it('EmptyState drops its 320px min-height only when compact', () => {
    const tall = renderToStaticMarkup(<EmptyState icon={null} title="x" />);
    expect(tall).toContain('min-h-[320px]');
    const compact = renderToStaticMarkup(<EmptyState icon={null} title="x" compact />);
    expect(compact).not.toContain('min-h-[320px]');
  });

  it('an empty stage keeps the icon and its one line, with no New post button', () => {
    const out = renderToStaticMarkup(<StageEmpty stage="review" compact />);
    expect(out).toContain('Posts sent for review show up here.');
    expect(out).toContain('<svg');
    expect(out).not.toContain('>New post<');
    expect(out).not.toContain('<button');
    expect(out).not.toContain('min-h-[320px]');
  });

  it('the phone feed empty stage is the compact one, with no New post', () => {
    const out = renderToStaticMarkup(
      <PipelineFeed
        posts={[]}
        activeStage="parked"
        cache={{} as unknown as PresignCache}
        presignEnabled={false}
        onLongPressPost={() => {}}
      />,
    );
    expect(out).toContain('data-stage-empty="parked"');
    expect(out).not.toContain('min-h-[320px]');
    expect(out).not.toContain('>New post<');
  });
});

function isElement(node: ReactNode): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node;
}

function all(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    node.forEach((child: ReactNode) => all(child, out));
    return out;
  }
  if (!isElement(node)) return out;
  out.push(node);
  const props = node.props as { children?: ReactNode; footer?: ReactNode };
  all(props.children, out);
  return out;
}

function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (!isElement(node)) return '';
  return text((node.props as { children?: ReactNode }).children);
}

describe('Pipeline polish: move sheet', () => {
  function sheet(stage: Stage, role: string): ReactElement {
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
      post: x5Post({ stage, title: 'Spring drop' }),
      onClose: () => {},
      gate,
      gateState: GATE_IDLE,
      targetDate: '',
      role,
    })!;
  }

  it('every row is one line: no helper text under any action', () => {
    for (const [stage, role] of [
      ['draft', 'agency'],
      ['review', 'owner'],
      ['approved', 'admin'],
      ['review', 'client'],
    ] as const) {
      const tree = sheet(stage, role);
      const rows = all(tree).filter((el) => 'data-move-action' in (el.props as object));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const children = (row.props as { children?: ReactNode }).children;
        // One span (the label) per row, nothing under it.
        expect(Array.isArray(children) ? children.filter(Boolean) : [children]).toHaveLength(1);
      }
      expect(all(tree).some((el) => 'data-move-helper' in (el.props as object))).toBe(false);
      const words = text(tree);
      expect(words).not.toContain('Keeps it aside');
      expect(words).not.toContain('You can add a reason');
      expect(words).not.toContain('get it to approve');
    }
  });

  it('"Currently in" reads at text-base, like the rows', () => {
    const current = all(sheet('review', 'agency')).find(
      (el) => 'data-move-current' in (el.props as object),
    )!;
    expect(text(current)).toBe('Currently inReview');
    const className = (current.props as { className: string }).className;
    expect(className).toContain('text-base');
    expect(className).not.toContain('text-sm');
  });
});

describe('Pipeline polish: sheet header', () => {
  it('the sheet title clamps to two lines and breaks long words', () => {
    mount(
      <Sheet open onClose={() => {}} title={'A very long post title '.repeat(8)}>
        <p>body</p>
      </Sheet>,
    );
    const h2 = document.querySelector<HTMLElement>('[role="dialog"] h2');
    expect(h2?.className).toContain('line-clamp-2');
    expect(h2?.className).toContain('min-w-0');
    expect(h2?.className).toContain('[overflow-wrap:anywhere]');
  });
});

describe('Pipeline polish: chips and controls', () => {
  it('a cut chip row fades 24px at each cut edge', () => {
    expect(chipRowMask(true, true)).toBe(
      'linear-gradient(to right, transparent 0, black 24px, black calc(100% - 24px), transparent 100%)',
    );
  });

  it('the due filter and sort buttons are at least 44x44 on a phone and a laptop', () => {
    for (const isDesktop of [false, true]) {
      desktop = isDesktop;
      const el = mount(
        <div>
          <PipelineDateControl
            dateWindow="any"
            onDateWindowChange={() => {}}
            customRange={null}
            onCustomRangeChange={() => {}}
            weekStartDay={1}
          />
          <PipelineSortControl order={POST_SORT_DEFAULT} onOrderChange={() => {}} />
        </div>,
      );
      const due = el.querySelector<HTMLElement>('[data-date-filter]');
      const sort = el.querySelector<HTMLElement>('button[aria-label="Sort"]');
      for (const button of [due, sort]) {
        expect(button?.className).toContain('h-11');
        expect(button?.className).toContain('min-w-11');
      }
      act(() => root?.unmount());
      root = null;
      host?.remove();
    }
  });

  it('the sort and due menu rows are 44px tall', () => {
    const markup = renderToStaticMarkup(
      sortControlBody({ order: POST_SORT_DEFAULT, onOrderChange: () => {} }),
    );
    const rows = markup.match(/<button[^>]*role="menuitemradio"[^>]*>/g) ?? [];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toContain('h-11');
  });
});
