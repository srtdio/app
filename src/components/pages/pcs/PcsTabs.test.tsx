import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import {
  PCS_TAB_PARAM,
  parsePcsTab,
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
    expect(buttons.map((b) => (b.props as { children: string }).children)).toEqual([
      'Post',
      'Feedback',
    ]);
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
