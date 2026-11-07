// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { drawTick } = vi.hoisted(() => ({ drawTick: vi.fn() }));
vi.mock('@/lib/motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/motion')>()),
  drawTick,
}));

import {
  CheckpointCircle,
  checkpointCircleState,
  type CheckpointCircleProps,
} from '@/components/comments/CheckpointCircle';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(props: CheckpointCircleProps): HTMLElement {
  if (host === null) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  act(() => root?.render(<CheckpointCircle {...props} />));
  const el = host.querySelector<HTMLElement>('[data-checkpoint-circle]');
  if (el === null) throw new Error('no circle');
  return el;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  drawTick.mockReset();
});

describe('CheckpointCircle', () => {
  it('open is an ink ring with the number', () => {
    const el = render({ n: 3, state: 'open' });
    expect(el.textContent).toBe('3');
    expect(el.className).toContain('border-fg');
    expect(el.className).toContain('text-fg');
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });

  it('confirmed is filled good with a tick, no number', () => {
    const el = render({ n: 3, state: 'confirmed' });
    expect(el.textContent).toBe('');
    expect(el.querySelector('svg')).not.toBeNull();
    expect(el.className).toContain('bg-good-solid');
  });

  it('resolved (not confirmed) is a good outline with a tick', () => {
    const el = render({ n: 3, state: 'resolved' });
    expect(el.querySelector('svg')).not.toBeNull();
    expect(el.className).toContain('border-good');
    expect(el.className).toContain('bg-transparent');
  });

  it('pin is an ink dot with no number', () => {
    const el = render({ n: 9, state: 'pin' });
    expect(el.textContent).toBe('');
    expect(el.querySelector('.bg-fg')).not.toBeNull();
  });

  it('next is a dashed ring that still shows its number', () => {
    const el = render({ n: 4, state: 'next' });
    expect(el.textContent).toBe('4');
    expect(el.className).toContain('border-dashed');
  });

  it('sizes: list and marker are the 28 box, inline the 16 box', () => {
    expect(render({ n: 1, state: 'open', size: 'list' }).className).toContain('h-7');
    expect(render({ n: 1, state: 'open', size: 'marker' }).className).toContain('h-7');
    expect(render({ n: 1, state: 'open', size: 'inline' }).className).toContain('h-4');
  });

  it('draws the tick only when it turns done on screen, never on first paint', () => {
    render({ n: 1, state: 'resolved' });
    expect(drawTick).not.toHaveBeenCalled();
    render({ n: 1, state: 'open' });
    render({ n: 1, state: 'resolved' });
    expect(drawTick).toHaveBeenCalledTimes(1);
    // resolved -> confirmed is still a tick: no second draw.
    render({ n: 1, state: 'confirmed' });
    expect(drawTick).toHaveBeenCalledTimes(1);
  });
});

describe('checkpointCircleState', () => {
  it('maps the row to open / resolved / confirmed', () => {
    expect(checkpointCircleState({ resolved_at: null, accepted_at: null })).toBe('open');
    expect(checkpointCircleState({ resolved_at: 'x', accepted_at: null })).toBe('resolved');
    expect(checkpointCircleState({ resolved_at: 'x', accepted_at: 'y' })).toBe('confirmed');
  });
});
