// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { Switch } from '@/components/ui/Switch';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(checked: boolean, onChange = vi.fn()): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  act(() =>
    createRoot(host).render(<Switch checked={checked} onChange={onChange} label="Sound" />),
  );
  return host.querySelector<HTMLElement>('[role="switch"]')!;
}

describe('Switch', () => {
  it('is a named role="switch" carrying aria-checked', () => {
    expect(mount(true).getAttribute('aria-checked')).toBe('true');
    const off = mount(false);
    expect(off.getAttribute('aria-checked')).toBe('false');
    expect(off.getAttribute('aria-label')).toBe('Sound');
  });

  it('reports the flipped value on tap', () => {
    const onChange = vi.fn();
    const off = mount(false, onChange);
    act(() => off.click());
    expect(onChange).toHaveBeenCalledWith(true);
    const onOff = vi.fn();
    const on = mount(true, onOff);
    act(() => on.click());
    expect(onOff).toHaveBeenCalledWith(false);
  });

  it('track is lit-well and 44 tall; knob is lit-knob and moves on X only', () => {
    const on = mount(true);
    const track = on.querySelector('span[aria-hidden]')!;
    expect(track.className).toMatch(/\blit-well\b/);
    expect(track.className).toMatch(/\bh-11\b/);
    expect(track.className).toMatch(/\bbg-accent\b/);
    const knob = track.querySelector('span')!;
    expect(knob.className).toMatch(/\blit-knob\b/);
    expect(knob.className).toContain('translate-x-[24px]');
    expect(knob.className).not.toMatch(/translate-y|rotate|shadow/);
    const offKnob = mount(false).querySelector('span[aria-hidden] span')!;
    expect(offKnob.className).toContain('translate-x-0');
    expect(mount(false).querySelector('span[aria-hidden]')!.className).toMatch(/\bbg-panel-3\b/);
  });
});
