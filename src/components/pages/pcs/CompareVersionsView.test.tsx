import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import {
  compareVersionsView,
  resolveCompareMode,
  type CompareViewMode,
} from '@/components/pages/pcs/CompareVersionsView';
import { diffSegments } from '@/lib/text-diff';

// The unit environment is node (no DOM renderer), so these specs walk the JSX
// tree returned by the hookless compareVersionsView rather than mounting it.

function walk(node: ReactNode, strings: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, strings));
    return;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    strings.push(String(node));
    return;
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) return;
  walk(((node as ReactElement).props as { children?: ReactNode }).children, strings);
}

function texts(tree: ReactNode): string[] {
  const out: string[] = [];
  walk(tree, out);
  return out;
}

// Join adjacent string/number children so split template pieces ("Comparing v",
// 1, " ...") match as one line.
function joinedText(tree: ReactNode): string {
  return texts(tree).join('');
}

function collect(node: ReactNode, out: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, out));
    return;
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) return;
  const el = node as ReactElement;
  out.push(el);
  collect((el.props as { children?: ReactNode }).children, out);
}

function classNames(tree: ReactNode): string[] {
  const out: ReactElement[] = [];
  collect(tree, out);
  return out
    .map((el) => (el.props as { className?: string }).className)
    .filter((cls): cls is string => typeof cls === 'string');
}

function render(over: {
  fromCaption: string | null;
  toCaption: string | null;
  mode?: CompareViewMode;
  onModeChange?: (mode: CompareViewMode) => void;
  onBack?: () => void;
}): ReactNode {
  const diff = diffSegments(over.fromCaption ?? '', over.toCaption ?? '');
  return compareVersionsView({
    fromVersionNumber: 1,
    toVersionNumber: 2,
    fromCreatedAt: '2026-06-01T00:00:00.000Z',
    toCreatedAt: '2026-06-02T00:00:00.000Z',
    fromCaption: over.fromCaption,
    toCaption: over.toCaption,
    onBack: over.onBack ?? (() => {}),
    diff,
    mode: over.mode ?? 'auto',
    onModeChange: over.onModeChange ?? (() => {}),
  });
}

describe('resolveCompareMode', () => {
  it('auto stays inline below 25% and crosses to side at 25%', () => {
    expect(resolveCompareMode('auto', 0)).toBe('inline');
    expect(resolveCompareMode('auto', 24)).toBe('inline');
    expect(resolveCompareMode('auto', 25)).toBe('side');
    expect(resolveCompareMode('auto', 80)).toBe('side');
  });

  it('an explicit pick passes through unchanged', () => {
    expect(resolveCompareMode('inline', 90)).toBe('inline');
    expect(resolveCompareMode('side', 0)).toBe('side');
  });
});

describe('compareVersionsView banner', () => {
  it('shows the version header and stats', () => {
    const tree = render({ fromCaption: 'hello world', toCaption: 'hello brave world' });
    const joined = joinedText(tree);
    expect(joined).toContain('Comparing v1 → v2');
    expect(joined).toContain('+1');
    expect(joined).toContain('−0');
    expect(joined).toContain('20% changed');
  });

  it('wires the Back button to onBack', () => {
    const onBack = vi.fn();
    const tree = render({ fromCaption: 'a', toCaption: 'b', onBack });
    const els: ReactElement[] = [];
    collect(tree, els);
    const back = els.find((el) => (el.props as { onClick?: () => void }).onClick === onBack);
    expect(back).toBeDefined();
    expect(joinedText(back)).toContain('Back');
  });
});

describe('compareVersionsView layouts', () => {
  it('inline marks added and removed words', () => {
    const tree = render({ fromCaption: 'alpha beta', toCaption: 'alpha gamma', mode: 'inline' });
    const classes = classNames(tree).join(' ');
    expect(classes).toContain('bg-good-soft');
    expect(classes).toContain('bg-bad-soft');
  });

  it('side-by-side left drops adds, right drops dels', () => {
    const tree = render({
      fromCaption: 'keep remove',
      toCaption: 'keep insert',
      mode: 'side',
    });
    // Both a del (remove) and an add (insert) exist across the two panels.
    const classes = classNames(tree).join(' ');
    expect(classes).toContain('bg-good-soft');
    expect(classes).toContain('bg-bad-soft');
  });

  it('renders the no-caption message for an empty side', () => {
    const tree = render({ fromCaption: null, toCaption: 'now has text', mode: 'side' });
    expect(joinedText(tree)).toContain('No caption in this version.');
  });

  it('auto hint states the chosen layout', () => {
    const tree = render({ fromCaption: 'alpha beta', toCaption: 'alpha gamma', mode: 'auto' });
    expect(joinedText(tree)).toContain('Auto chose');
  });
});

describe('compareVersionsView guard path', () => {
  it('shows plain side-by-side with stats and no marks when segs is null', () => {
    const a = Array.from({ length: 1500 }, (_, i) => `a${i}`).join(' ');
    const b = Array.from({ length: 1500 }, (_, i) => `b${i}`).join(' ');
    const tree = render({ fromCaption: a, toCaption: b, mode: 'auto' });
    const classes = classNames(tree).join(' ');
    // No per-word marks on the guard path.
    expect(classes).not.toContain('bg-good-soft');
    expect(classes).not.toContain('bg-bad-soft');
    // Stats still shown.
    expect(joinedText(tree)).toContain('100% changed');
    // Both full captions present.
    expect(joinedText(tree)).toContain('a0');
    expect(joinedText(tree)).toContain('b0');
  });
});
