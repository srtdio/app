import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { PinOverlay } from '@/components/pages/pcs/PinOverlay';
import type { PinDot } from '@/components/pages/pcs/pin-annotations';

// node test environment (no DOM renderer): PinOverlay is hookless, so call it as a
// function and walk the returned tree, mirroring the lightbox view tests.

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

function dots(tree: ReactNode): ReactElement[] {
  return elements(tree).filter((el) =>
    String((el.props as { 'aria-label'?: string })['aria-label'] ?? '').startsWith('Pin '),
  );
}

const PIN = (over: Partial<PinDot>): PinDot => ({
  n: 1,
  annotationId: 'an-1',
  commentId: 'c-1',
  x: 0.5,
  y: 0.5,
  ...over,
});

describe('PinOverlay', () => {
  it('renders one dot per pin at its normalized position', () => {
    const tree = PinOverlay({
      pins: [
        PIN({ n: 3, annotationId: 'a', commentId: 'c-a', x: 0.25, y: 0.75 }),
        PIN({ n: 4, annotationId: 'b', commentId: 'c-b', x: 0.5, y: 0.1 }),
      ],
      onPinClick: () => {},
    });
    const found = dots(tree);
    expect(found).toHaveLength(2);
    const first = found[0]!.props as { style: { left: string; top: string } };
    expect(first.style.left).toBe('25%');
    expect(first.style.top).toBe('75%');
  });

  it('skips an out-of-range pin defensively', () => {
    const tree = PinOverlay({
      pins: [
        PIN({ annotationId: 'ok', x: 0.5, y: 0.5 }),
        PIN({ annotationId: 'bad', x: 1.5, y: 0.5 }),
      ],
      onPinClick: () => {},
    });
    expect(dots(tree)).toHaveLength(1);
  });

  it('calls onPinClick with the linked comment id', () => {
    const onPinClick = vi.fn();
    const tree = PinOverlay({
      pins: [PIN({ annotationId: 'a', commentId: 'comment-42' })],
      onPinClick,
    });
    (dots(tree)[0]!.props as { onClick: () => void }).onClick();
    expect(onPinClick).toHaveBeenCalledWith('comment-42');
  });

  it('gives each dot a >=44x44 hit target', () => {
    const tree = PinOverlay({ pins: [PIN({})], onPinClick: () => {} });
    const className = (dots(tree)[0]!.props as { className: string }).className;
    expect(className).toContain('h-11');
    expect(className).toContain('w-11');
  });
});
