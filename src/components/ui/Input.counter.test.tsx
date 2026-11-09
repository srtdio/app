// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { INPUT_COUNTER_ROOM, Input } from '@/components/ui/Input';

// ui/Input `counter`: an optional live length counter at the trailing edge, in
// the meta role. Omitted, the input renders exactly as before (no wrapper).

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

async function mount(node: ReactNode): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(node);
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('ui/Input counter', () => {
  it('without the prop: the bare input, no counter, no reserved room', async () => {
    const host = await mount(<Input aria-label="Name" />);
    expect(host.firstElementChild?.tagName).toBe('INPUT');
    expect(host.querySelector('[data-input-counter]')).toBeNull();
    expect(host.querySelector('input')?.className).not.toContain(INPUT_COUNTER_ROOM);
  });

  it('null: the room and the live region are kept, empty', async () => {
    const host = await mount(<Input aria-label="Name" counter={null} />);
    const counter = host.querySelector('[data-input-counter]');
    expect(counter).not.toBeNull();
    expect(counter?.textContent).toBe('');
    expect(counter?.getAttribute('aria-live')).toBe('polite');
    expect(host.querySelector('input')?.className).toContain(INPUT_COUNTER_ROOM);
  });

  it('a value: shows it in the meta role (mono, tabular)', async () => {
    const host = await mount(<Input aria-label="Name" counter="20/25" />);
    const counter = host.querySelector('[data-input-counter]');
    expect(counter?.textContent).toBe('20/25');
    expect(counter?.className).toContain('font-mono');
    expect(counter?.className).toContain('tabular-nums');
    expect(counter?.className).toContain('pointer-events-none');
  });

  it('keeps the field height (h-11) and passes props through', async () => {
    const host = await mount(<Input aria-label="Name" counter="25/25" maxLength={25} />);
    const input = host.querySelector('input');
    expect(input?.className).toContain('h-11');
    expect(input?.getAttribute('maxlength')).toBe('25');
  });
});
