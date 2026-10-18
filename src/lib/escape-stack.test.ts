// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { escapeLayerCount, pushEscapeLayer } from '@/lib/escape-stack';

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

const pops: Array<() => void> = [];
afterEach(() => {
  while (pops.length > 0) pops.pop()?.();
});

describe('escape stack', () => {
  it('sends Escape only to the top layer', () => {
    const sheet = vi.fn();
    const select = vi.fn();
    pops.push(pushEscapeLayer(sheet));
    pops.push(pushEscapeLayer(select));
    pressEscape();
    expect(select).toHaveBeenCalledTimes(1);
    expect(sheet).not.toHaveBeenCalled();
  });

  it('popping the top layer restores the one below', () => {
    const sheet = vi.fn();
    const select = vi.fn();
    pops.push(pushEscapeLayer(sheet));
    const popSelect = pushEscapeLayer(select);
    popSelect();
    pressEscape();
    expect(sheet).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
  });

  it('popping a lower layer keeps the top on top', () => {
    const a = vi.fn();
    const b = vi.fn();
    const popA = pushEscapeLayer(a);
    pops.push(pushEscapeLayer(b));
    popA();
    pressEscape();
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    expect(escapeLayerCount()).toBe(1);
  });

  it('ignores other keys and does nothing with no layers', () => {
    const a = vi.fn();
    const popA = pushEscapeLayer(a);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(a).not.toHaveBeenCalled();
    popA();
    expect(escapeLayerCount()).toBe(0);
    pressEscape();
    expect(a).not.toHaveBeenCalled();
  });
});
