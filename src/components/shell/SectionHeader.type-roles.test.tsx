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

async function mount(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <SectionHeader
        title="Briefs"
        search={{ value: '', onChange: () => {}, placeholder: 'Search briefs' }}
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
});
