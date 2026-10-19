// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Select, type SelectOption } from '@/components/ui/Select';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const options: SelectOption[] = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Bravo' },
  { value: 'c', label: 'Charlie' },
];

let root: Root | null = null;

async function mount(value = 'b') {
  const onChange = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<Select value={value} options={options} onChange={onChange} label="Owner" />);
  });
  const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]');
  if (trigger === null) throw new Error('no trigger');
  await act(async () => trigger.click());
  const listbox = document.querySelector<HTMLElement>('[role="listbox"]');
  if (listbox === null) throw new Error('no listbox');
  return { trigger, listbox, onChange };
}

const focusedLabel = () => document.activeElement?.textContent?.trim();

async function key(name: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
  return event;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Select listbox keyboard', () => {
  it('opening focuses the selected option', async () => {
    await mount('b');
    expect(document.activeElement?.getAttribute('role')).toBe('option');
    expect(document.activeElement?.getAttribute('aria-selected')).toBe('true');
    expect(focusedLabel()).toBe('Bravo');
  });

  it('with no selection, the first option takes focus', async () => {
    await mount('');
    expect(focusedLabel()).toBe('Alpha');
  });

  it('ArrowDown/ArrowUp move without wrapping; Home and End jump', async () => {
    await mount('b');
    expect((await key('ArrowDown')).defaultPrevented).toBe(true);
    expect(focusedLabel()).toBe('Charlie');
    await key('ArrowDown');
    expect(focusedLabel()).toBe('Charlie');
    await key('Home');
    expect(focusedLabel()).toBe('Alpha');
    await key('ArrowUp');
    expect(focusedLabel()).toBe('Alpha');
    await key('End');
    expect(focusedLabel()).toBe('Charlie');
    await key('ArrowUp');
    expect(focusedLabel()).toBe('Bravo');
  });

  it('Enter picks the focused option, closes, and hands focus back to the trigger', async () => {
    const { trigger, onChange } = await mount('b');
    await key('ArrowDown');
    const event = await key('Enter');
    expect(event.defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenCalledWith('c');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('Escape closes through the escape stack and returns focus to the trigger', async () => {
    const { trigger, onChange } = await mount('b');
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it('other keys are left alone', async () => {
    await mount('b');
    const event = await key('a');
    expect(event.defaultPrevented).toBe(false);
    expect(focusedLabel()).toBe('Bravo');
  });
});
