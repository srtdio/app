// @vitest-environment jsdom
// Type roles on Help (design rules, 24 Oct 2026): the hero heading is the
// screen header (lg/600, was 2xl/3xl), "Help articles" is the section label
// (sm/600 uppercase tracking-[0.06em] fg-2), the article count is sm fg-3 meta,
// an article row title is base/500, and no match reads as an empty state
// (lg/600 title, base fg-2 description).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { HelpPage } from '@/components/pages/HelpPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

async function mount(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={['/help']}>
        <HelpPage />
      </MemoryRouter>,
    );
  });
}

/** The deepest element whose whole text is `text`. */
function byText(text: string): HTMLElement {
  const hits = [...document.body.querySelectorAll<HTMLElement>('*')].filter(
    (el) => el.textContent?.trim() === text,
  );
  const deepest = hits.find((el) => ![...el.children].some((c) => c.textContent?.trim() === text));
  if (deepest === undefined) throw new Error(`no element with text "${text}"`);
  return deepest;
}

function expectRole(el: Element, classes: string[]): void {
  const list = el.className.split(/\s+/);
  for (const c of classes) expect(list).toContain(c);
}

async function typeSearch(value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('#help-search');
  expect(input).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Help page type roles', () => {
  it('the hero heading is the screen header: lg/600, no 2xl or 3xl', async () => {
    await mount();
    const hero = byText('Find your way through the workflow');
    expectRole(hero, ['text-lg', 'font-semibold']);
    expect(hero.className).not.toMatch(/text-(2xl|3xl)/);
    expect(hero.className).not.toContain('md:text-');
  });

  it('"Help articles" is the section label and the count is sm fg-3 meta', async () => {
    await mount();
    const label = byText('Help articles');
    expectRole(label, ['text-sm', 'font-semibold', 'uppercase', 'tracking-[0.06em]', 'text-fg-2']);
    const count = label.nextElementSibling as HTMLElement;
    expect(count.textContent).toMatch(/^\d+ articles?$/);
    expectRole(count, ['text-sm', 'text-fg-3']);
  });

  it('an article row title is base/500 and its answer is base fg-2', async () => {
    await mount();
    const summary = document.querySelector('summary');
    expect(summary).not.toBeNull();
    expectRole(summary as HTMLElement, ['text-base', 'font-medium']);
    const answer = summary?.parentElement?.querySelector('p');
    expectRole(answer as HTMLElement, ['text-base', 'text-fg-2']);
  });

  it('no match reads as an empty state', async () => {
    await mount();
    await typeSearch('zzzz-no-such-article');
    expectRole(byText('No help articles like that'), ['text-lg', 'font-semibold']);
    expectRole(byText('Try another search or choose a different topic.'), [
      'text-base',
      'text-fg-2',
    ]);
  });
});
