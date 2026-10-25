// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { SectionHeader } from '@/components/shell/SectionHeader';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function mount(value = ''): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <SectionHeader
        title="Briefs"
        search={{ value, onChange: () => {}, placeholder: 'Search briefs' }}
      />,
    );
  });
}

describe('SectionHeader type roles', () => {
  it('title is the screen header: text-lg font-semibold', async () => {
    await mount();
    const title = [...document.querySelectorAll('h2')].find((h) => h.textContent === 'Briefs');
    const classes = (title?.className ?? '').split(/\s+/);
    expect(classes).toContain('text-lg');
    expect(classes).toContain('font-semibold');
  });

  it('search field is 16px below md and 14px from md up', async () => {
    await mount();
    const input = document.querySelector<HTMLInputElement>('input[type="search"]');
    const classes = (input?.className ?? '').split(/\s+/);
    expect(classes).toContain('text-input');
    expect(classes).toContain('md:text-base');
    expect(classes).not.toContain('text-base');
  });

  // Audit A1-01: the placeholder must fit a 360px phone row beside sort and New,
  // so the insets stay tight and the Clear button's 44px is reserved only while
  // it shows.
  it('search field uses tight insets while empty', async () => {
    await mount();
    const input = document.querySelector<HTMLInputElement>('input[type="search"]');
    const classes = (input?.className ?? '').split(/\s+/);
    expect(classes).toContain('pl-7');
    expect(classes).toContain('pr-2');
    expect(classes).not.toContain('pr-11');
    expect(classes).not.toContain('pl-9');
    const icon = input?.parentElement?.querySelector('span.pointer-events-none');
    expect((icon?.className ?? '').split(/\s+/)).toContain('left-2');
  });

  it('search field reserves the Clear button inset only while it has a value', async () => {
    await mount('diwali');
    const input = document.querySelector<HTMLInputElement>('input[type="search"]');
    const classes = (input?.className ?? '').split(/\s+/);
    expect(classes).toContain('pr-11');
    expect(classes).not.toContain('pr-2');
  });

  it('search box takes the remaining row width', async () => {
    await mount();
    const box = document.querySelector<HTMLInputElement>('input[type="search"]')?.parentElement;
    const classes = (box?.className ?? '').split(/\s+/);
    expect(classes).toContain('flex-1');
    expect(classes).toContain('min-w-0');
  });
});
