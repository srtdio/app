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

  it('the hit row stays 44 tall; the pill inside is 51x31', () => {
    const row = mount(false);
    expect(row.tagName).toBe('BUTTON');
    expect(row.getAttribute('type')).toBe('button');
    expect(row.className).toMatch(/\bh-11\b/);
    expect(row.className).toContain('min-h-[44px]');
    const pill = row.querySelector('span[aria-hidden]')!;
    expect(pill.className).toContain('h-[31px]');
    expect(pill.className).toContain('w-[51px]');
    expect(pill.className).toMatch(/\brounded-full\b/);
    expect(pill.className).toContain('border-[1.5px]');
  });

  it('on: accent fill, no line, accent-fg knob 20px across, X only', () => {
    const pill = mount(true).querySelector('span[aria-hidden]')!;
    expect(pill.className).toMatch(/\bbg-accent\b/);
    expect(pill.className).toMatch(/\bborder-transparent\b/);
    expect(pill.className).toMatch(/\blit-well\b/);
    const knob = pill.querySelector('span')!;
    expect(knob.className).toContain('h-[23px]');
    expect(knob.className).toContain('w-[23px]');
    expect(knob.className).toMatch(/\blit-knob\b/);
    expect(knob.className).toMatch(/\bbg-accent-fg\b/);
    expect(knob.className).toMatch(/\btranslate-x-5\b/);
    expect(knob.className).toMatch(/\bmv-slide\b/);
    expect(knob.className).not.toMatch(/translate-y|rotate|shadow|\bring-|\bborder\b/);
  });

  it('off: a clear track with the field line, lit-well, and an ink knob at rest', () => {
    const pill = mount(false).querySelector('span[aria-hidden]')!;
    expect(pill.className).toMatch(/\bbg-transparent\b/);
    expect(pill.className).toMatch(/\bborder-field\b/);
    expect(pill.className).toMatch(/\blit-well\b/);
    expect(pill.className).not.toMatch(/\bbg-panel-[23]\b|\bborder-border-strong\b/);
    const knob = pill.querySelector('span')!;
    expect(knob.className).toMatch(/\bbg-fg\b/);
    expect(knob.className).toMatch(/\blit-knob\b/);
    expect(knob.className).toMatch(/\btranslate-x-0\b/);
  });

  it('hover, press and the focus line follow the pill, not the 44px row', () => {
    const row = mount(false);
    const pill = row.querySelector('span[aria-hidden]')!;
    expect(pill.className).toMatch(/\blit-hover\b/);
    expect(pill.className).toContain('group-focus-visible:lit-focus');
    expect(row.className).toMatch(/\bgroup\b/);
    expect(row.className).not.toMatch(/\blit-hover\b|focus-visible:lit-focus/);
  });
});
