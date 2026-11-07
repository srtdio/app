import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { PinOverlay } from '@/components/pages/pcs/PinOverlay';
import { IconButton } from '@/components/ui/IconButton';
import { CheckpointCircle } from '@/components/comments/CheckpointCircle';
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

// Each dot is an IconButton; it is hookless, so expand it to the <button> it renders.
function dots(tree: ReactNode): ReactElement[] {
  return elements(tree)
    .map((el) =>
      el.type === IconButton ? IconButton(el.props as Parameters<typeof IconButton>[0]) : el,
    )
    .filter((el) =>
      String((el.props as { 'aria-label'?: string })['aria-label'] ?? '').startsWith('Pin '),
    );
}

const PIN = (over: Partial<PinDot>): PinDot => ({
  n: 1,
  state: 'open',
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

  it('the marker is the checkpoint circle: number and state from the checkpoint', () => {
    const tree = PinOverlay({
      pins: [
        PIN({ n: 2, state: 'open', annotationId: 'a' }),
        PIN({ n: 3, state: 'resolved', annotationId: 'b' }),
        PIN({ n: 4, state: 'confirmed', annotationId: 'c' }),
      ],
      onPinClick: () => {},
    });
    const circles = elements(tree)
      .filter((el) => el.type === CheckpointCircle)
      .map((el) => el.props);
    expect(circles).toEqual([
      { n: 2, state: 'open', size: 'marker' },
      { n: 3, state: 'resolved', size: 'marker' },
      { n: 4, state: 'confirmed', size: 'marker' },
    ]);
  });

  it('an agency pin (no checkpoint) is the ink dot with no number, named "Pin"', () => {
    const tree = PinOverlay({
      pins: [PIN({ n: null, state: 'pin', annotationId: 'ag' })],
      onPinClick: () => {},
    });
    const circle = elements(tree).find((el) => el.type === CheckpointCircle);
    expect(circle?.props).toEqual({ state: 'pin', size: 'marker' });
    const button = elements(tree).find((el) => el.type === IconButton);
    expect((button?.props as { label: string }).label).toBe('Pin');
  });

  it('no gold: the marker carries no annotation token', () => {
    const tree = PinOverlay({ pins: [PIN({})], onPinClick: () => {} });
    for (const el of elements(tree)) {
      expect(String((el.props as { className?: string }).className ?? '')).not.toContain(
        'annotation',
      );
    }
  });
});
