import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import {
  PCS_TAB_PARAM,
  PcsTabs,
  parsePcsTab,
  pcsTabBadge,
  pcsTabButtons,
  pcsTabPanelClass,
  pcsTabPanelId,
  withPcsTab,
} from '@/components/pages/pcs/PcsTabs';

// The unit environment is node (no DOM renderer), so these specs walk the JSX
// tree returned by the hookless pcsTabButtons, mirroring the CaptionView test
// style.

function flatten(node: ReactNode, out: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => flatten(child, out));
    return;
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) return;
  const el = node as ReactElement;
  out.push(el);
  flatten((el.props as { children?: ReactNode }).children, out);
}

function elements(tree: ReactNode): ReactElement[] {
  const out: ReactElement[] = [];
  flatten(tree, out);
  return out;
}

type Props = Record<string, unknown>;

function tabs(tree: ReactNode): ReactElement[] {
  return elements(tree).filter((el) => (el.props as Props).role === 'tab');
}

/** All string/number children under a node, concatenated (badge-aware label text). */
function text(node: ReactNode): string {
  const parts: string[] = [];
  const walk = (child: ReactNode): void => {
    if (Array.isArray(child)) {
      child.forEach(walk);
      return;
    }
    if (typeof child === 'string' || typeof child === 'number') {
      parts.push(String(child));
      return;
    }
    if (child !== null && typeof child === 'object' && 'props' in child) {
      walk((child.props as { children?: ReactNode }).children);
    }
  };
  walk(node);
  return parts.join('');
}

describe('parsePcsTab', () => {
  it("defaults to 'post' for absent, empty, or unknown values", () => {
    expect(parsePcsTab(null)).toBe('post');
    expect(parsePcsTab('')).toBe('post');
    expect(parsePcsTab('post')).toBe('post');
    expect(parsePcsTab('nonsense')).toBe('post');
  });

  it("returns 'feedback' only for the exact value", () => {
    expect(parsePcsTab('feedback')).toBe('feedback');
    expect(parsePcsTab('Feedback')).toBe('post');
  });
});

describe('withPcsTab', () => {
  it('sets the param for feedback and preserves sibling params', () => {
    const params = new URLSearchParams('comment=c1');
    const next = withPcsTab(params, 'feedback');
    expect(next.get(PCS_TAB_PARAM)).toBe('feedback');
    expect(next.get('comment')).toBe('c1');
  });

  it('deletes the param for the default post tab so the URL stays clean', () => {
    const params = new URLSearchParams(`${PCS_TAB_PARAM}=feedback&comment=c1`);
    const next = withPcsTab(params, 'post');
    expect(next.get(PCS_TAB_PARAM)).toBeNull();
    expect(next.get('comment')).toBe('c1');
  });

  it('never mutates its input', () => {
    const params = new URLSearchParams();
    withPcsTab(params, 'feedback');
    expect(params.get(PCS_TAB_PARAM)).toBeNull();
  });

  it('round-trips through parsePcsTab for both tabs', () => {
    for (const tab of ['post', 'feedback'] as const) {
      expect(parsePcsTab(withPcsTab(new URLSearchParams(), tab).get(PCS_TAB_PARAM))).toBe(tab);
    }
  });
});

describe('pcsTabButtons', () => {
  it('renders exactly two 44px tabs inside a labelled tablist', () => {
    const tree = pcsTabButtons('post', () => {});
    const list = elements(tree).find((el) => (el.props as Props).role === 'tablist')!;
    expect(list).toBeDefined();
    expect((list.props as Props)['aria-label']).toBe('Post sections');

    const buttons = tabs(tree);
    expect(buttons.length).toBe(2);
    for (const button of buttons) {
      expect(button.type).toBe('button');
      expect((button.props as Props).type).toBe('button');
      expect((button.props as { className: string }).className).toContain('min-h-[44px]');
    }
    expect(buttons.map((b) => text(b))).toEqual(['Post', 'Feedback']);
  });

  it('marks only the active tab selected and wires aria-controls to its panel id', () => {
    const tree = pcsTabButtons('feedback', () => {});
    const [post, feedback] = tabs(tree) as [ReactElement, ReactElement];
    expect((post.props as Props)['aria-selected']).toBe(false);
    expect((feedback.props as Props)['aria-selected']).toBe(true);
    expect((post.props as Props)['aria-controls']).toBe(pcsTabPanelId('post'));
    expect((feedback.props as Props)['aria-controls']).toBe(pcsTabPanelId('feedback'));
  });

  it('clicking a tab reports its value to onSelect', () => {
    const onSelect = vi.fn();
    const [post, feedback] = tabs(pcsTabButtons('post', onSelect)) as [ReactElement, ReactElement];
    (feedback.props as { onClick: () => void }).onClick();
    expect(onSelect).toHaveBeenCalledWith('feedback');
    (post.props as { onClick: () => void }).onClick();
    expect(onSelect).toHaveBeenCalledWith('post');
  });
});

describe('feedback count badge', () => {
  it('renders nothing when the count is absent or zero (backward compatible)', () => {
    expect(pcsTabBadge(undefined, false)).toBeNull();
    expect(pcsTabBadge(0, false)).toBeNull();
    const [post, feedback] = tabs(pcsTabButtons('post', () => {})) as [ReactElement, ReactElement];
    expect(text(post)).toBe('Post');
    expect(text(feedback)).toBe('Feedback');
    // The PcsTabs wrapper accepts the old two-prop shape unchanged.
    const [, wrapped] = tabs(PcsTabs({ active: 'post', onSelect: () => {} })) as [
      ReactElement,
      ReactElement,
    ];
    expect(text(wrapped)).toBe('Feedback');
  });

  it('shows the count on the Feedback label only, never on Post', () => {
    const [post, feedback] = tabs(pcsTabButtons('post', () => {}, 3)) as [
      ReactElement,
      ReactElement,
    ];
    expect(text(post)).toBe('Post');
    expect(text(feedback)).toBe('Feedback3');
    const badge = elements(feedback).find((el) =>
      String((el.props as Props).className ?? '').includes('rounded-full'),
    )!;
    expect(badge).toBeDefined();
    expect((badge.props as { className: string }).className).toContain('tabular-nums');
  });

  it('inverts the badge fill on the selected (accent) segment for legibility', () => {
    const [, selected] = tabs(pcsTabButtons('feedback', () => {}, 2)) as [
      ReactElement,
      ReactElement,
    ];
    const badge = elements(selected).find((el) =>
      String((el.props as Props).className ?? '').includes('rounded-full'),
    )!;
    expect((badge.props as { className: string }).className).toContain('bg-accent-fg');

    const [, unselected] = tabs(pcsTabButtons('post', () => {}, 2)) as [ReactElement, ReactElement];
    const idle = elements(unselected).find((el) =>
      String((el.props as Props).className ?? '').includes('rounded-full'),
    )!;
    expect((idle.props as { className: string }).className).toContain('bg-accent-soft');
  });
});

describe('pcsTabPanelClass', () => {
  it('shows a visible panel and display-hides a hidden one below md only', () => {
    expect(pcsTabPanelClass(true, true)).toContain('flex');
    expect(pcsTabPanelClass(true, true)).not.toContain('hidden');
    expect(pcsTabPanelClass(false, true)).toContain('hidden md:flex');
  });

  it('animates the swap with opacity/translateY only, pinned at rest on md+', () => {
    const entering = pcsTabPanelClass(true, false);
    expect(entering).toContain('opacity-0');
    expect(entering).toContain('translate-y-1');
    expect(entering).toContain('md:translate-y-0 md:opacity-100');

    const rested = pcsTabPanelClass(true, true);
    expect(rested).toContain('opacity-100');
    expect(rested).toContain('translate-y-0');

    // No horizontal slide, no rotation, ever.
    for (const cls of [entering, rested]) {
      expect(cls).not.toMatch(/translate-x|rotate|scale/);
      expect(cls).toContain('transition-[opacity,transform]');
    }
  });
});
