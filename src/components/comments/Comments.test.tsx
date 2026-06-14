import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { annotationChip, commentDomId } from '@/components/comments/Comments';

// Node unit environment: walk the JSX returned by the hookless chip helper and
// assert the row id format, rather than mounting the stateful Comments list.

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

function text(tree: ReactNode): string {
  const parts: string[] = [];
  for (const el of elements(tree)) {
    const children = (el.props as { children?: ReactNode }).children;
    const kids = Array.isArray(children) ? children : [children];
    for (const child of kids) {
      if (typeof child === 'string' || typeof child === 'number') parts.push(String(child));
    }
  }
  return parts.join('');
}

describe('commentDomId', () => {
  it('builds a stable per-comment row id', () => {
    expect(commentDomId('abc')).toBe('comment-abc');
  });
});

describe('annotationChip', () => {
  it('renders a clickable live chip that calls onAnnotationChipClick', () => {
    const onClick = vi.fn();
    const tree = annotationChip(
      'c1',
      { n: 2, quote: 'great hook', stale: false, versionNumber: 3 },
      onClick,
    );
    const button = elements(tree).find((el) => el.type === 'button')!;
    expect(button).toBeDefined();
    expect(text(tree)).toContain('great hook');
    (button.props as { onClick: () => void }).onClick();
    expect(onClick).toHaveBeenCalledWith('c1');
  });

  it('renders a greyed, non-interactive stale chip', () => {
    const tree = annotationChip(
      'c2',
      { n: 0, quote: 'old copy', stale: true, versionNumber: 1 },
      vi.fn(),
    );
    expect(elements(tree).some((el) => el.type === 'button')).toBe(false);
    expect(text(tree)).toContain('copy changed · v1');
    expect(text(tree)).toContain('old copy');
  });

  it('renders nothing when there is no annotation (brief parity)', () => {
    expect(annotationChip('c3', undefined)).toBeNull();
  });
});
