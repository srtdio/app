// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';

// The button system's fields: Input, the compact Textarea and the Select
// trigger are 44 tall (h-11, or min-h-[44px] for the growing composer field),
// with an 8px radius on the panel-2 fill.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

async function mount(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <>
        <Input aria-label="Title" />
        <Textarea aria-label="Caption" compact />
        <Select value="a" options={[{ value: 'a', label: 'Alpha' }]} onChange={() => {}} />
      </>,
    );
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function classesOf(host: HTMLElement, selector: string): string[] {
  const el = host.querySelector(selector);
  if (el === null) throw new Error(`missing ${selector}`);
  return el.className.split(/\s+/);
}

const STALE = ['h-9', 'h-10', 'h-12', 'rounded-md', 'rounded-xl', 'rounded-full', 'font-semibold'];

describe('field shape', () => {
  it('Input is rounded-lg bg-panel-2 h-11', async () => {
    const classes = classesOf(await mount(), 'input');
    expect(classes).toEqual(expect.arrayContaining(['rounded-lg', 'bg-panel-2', 'h-11']));
    for (const stale of STALE) expect(classes).not.toContain(stale);
  });

  it('compact Textarea is rounded-lg bg-panel-2 min-h-[44px]', async () => {
    const classes = classesOf(await mount(), 'textarea');
    expect(classes).toEqual(expect.arrayContaining(['rounded-lg', 'bg-panel-2', 'min-h-[44px]']));
    for (const stale of STALE) expect(classes).not.toContain(stale);
  });

  it('Select trigger is rounded-lg bg-panel-2 h-11', async () => {
    const classes = classesOf(await mount(), 'button[aria-haspopup="listbox"]');
    expect(classes).toEqual(expect.arrayContaining(['rounded-lg', 'bg-panel-2', 'h-11']));
    for (const stale of STALE) expect(classes).not.toContain(stale);
  });
});
