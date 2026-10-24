// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

async function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <>
        <Input aria-label="Title" />
        <Textarea aria-label="Caption" />
        <Select value="a" options={[{ value: 'a', label: 'Alpha' }]} onChange={() => {}} />
      </>,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

// iOS Safari zooms the page when a focused field's text is under 16px. Every
// field is 16px (text-input) below md and keeps 14px (text-base) from md up.
function expectSixteenBelowMd(el: Element | null): void {
  if (el === null) throw new Error('missing field');
  const classes = el.className.split(/\s+/);
  expect(classes).toContain('text-input');
  expect(classes).toContain('md:text-base');
  expect(classes).not.toContain('text-base');
  expect(classes).not.toContain('text-lg');
}

describe('T8/FT2: 16px fields below md (no iOS zoom on focus)', () => {
  it('Input', async () => {
    await mount();
    expectSixteenBelowMd(document.querySelector('input[aria-label="Title"]'));
  });

  it('Textarea', async () => {
    await mount();
    expectSixteenBelowMd(document.querySelector('textarea[aria-label="Caption"]'));
  });

  it('Select trigger', async () => {
    await mount();
    expectSixteenBelowMd(document.querySelector('button[aria-haspopup="listbox"]'));
  });
});
