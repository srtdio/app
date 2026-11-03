// @vitest-environment jsdom
// CountBadge small touch (docs/motion.md): the first paint never moves; a
// count that changes on screen rolls its digits one step on Y (rollDigit,
// 160 ms; up when it grew, down when it fell); a badge appearing from zero
// pops from .9. Never a fade.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CountBadge } from '@/components/ui/CountBadge';
import { resetMotionPreferenceForTests, resetPlayerForTests } from '@/lib/motion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const animate = vi.fn((_frames: Keyframe[], _options?: KeyframeAnimationOptions) => ({
  finish: vi.fn(),
  addEventListener: vi.fn(),
}));
const proto = HTMLElement.prototype as { animate?: unknown };
const original = proto.animate;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  animate.mockClear();
  proto.animate = animate;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  proto.animate = original;
  resetMotionPreferenceForTests();
  resetPlayerForTests();
});

function show(count: number): void {
  act(() => {
    root?.render(<CountBadge count={count} />);
  });
}

const badge = (): HTMLElement | null => document.querySelector('[data-count-badge]');
const frames = (i: number): Keyframe[] => animate.mock.calls[i]?.[0] ?? [];

describe('CountBadge digit roll', () => {
  it('the first paint never moves and holds the digits directly', () => {
    show(3);
    expect(animate).not.toHaveBeenCalled();
    expect(badge()?.textContent).toBe('3');
    expect(badge()?.children).toHaveLength(0);
  });

  it('a count that grows rolls its digits up one step; a count that falls rolls down', () => {
    show(3);
    show(4);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.contexts[0]).toBe(badge()?.firstElementChild);
    expect(frames(0)).toEqual([{ transform: 'translateY(60%)' }, { transform: 'translateY(0)' }]);
    expect(animate.mock.calls[0]?.[1]?.duration).toBe(160);
    show(2);
    expect(frames(1)).toEqual([{ transform: 'translateY(-60%)' }, { transform: 'translateY(0)' }]);
    expect(badge()?.textContent).toBe('2');
  });

  it('the pill clips the rolling digits and never fades', () => {
    show(1);
    show(2);
    expect(badge()?.className).toContain('overflow-hidden');
    for (const call of animate.mock.calls) {
      expect(call[0].some((frame) => 'opacity' in frame)).toBe(false);
    }
  });

  it('99+ to 120 shows the same text: nothing moves', () => {
    show(150);
    show(120);
    expect(animate).not.toHaveBeenCalled();
  });

  it('appearing from zero pops the pill from .9 (no roll)', () => {
    show(0);
    expect(badge()).toBeNull();
    show(1);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.contexts[0]).toBe(badge());
    expect(frames(0)).toEqual([{ transform: 'scale(0.9)' }, { transform: 'scale(1)' }]);
  });
});
