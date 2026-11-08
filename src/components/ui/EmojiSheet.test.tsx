// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EmojiSheet, { RECENTS_HEADING, emojiSheetSections } from '@/components/ui/EmojiSheet';
import { EMOJI_LIST, EMOJI_RECENTS_KEY, readRecents } from '@/lib/chat/emoji-list';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  try {
    window.localStorage.clear();
  } catch {
    // Blocked storage: nothing to clear.
  }
});

async function mount(opts: { closeOnPick?: boolean } = {}) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <EmojiSheet open onClose={onClose} onPick={onPick} closeOnPick={opts.closeOnPick ?? true} />,
    );
    await wait(30);
  });
  return { onPick, onClose };
}

const search = () => document.querySelector<HTMLInputElement>('[data-emoji-search]');
const cell = (emoji: string, scope: Pick<Document, 'querySelectorAll'> = document) =>
  [...scope.querySelectorAll<HTMLButtonElement>('[data-emoji-cell]')].find(
    (b) => b.dataset.emojiCell === emoji,
  );

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('EmojiSheet', () => {
  it('renders every emoji-list group under its own name, with a section heading', async () => {
    await mount();
    const sections = [...document.querySelectorAll<HTMLElement>('[data-emoji-section]')];
    expect(sections.map((s) => s.getAttribute('aria-label'))).toEqual(
      EMOJI_LIST.map((g) => g.name),
    );
    for (const group of EMOJI_LIST) {
      const section = sections.find((s) => s.dataset.emojiSection === group.name);
      expect(section?.querySelector('h3')?.textContent).toBe(group.name);
      expect(section?.querySelectorAll('[data-emoji-cell]').length).toBe(group.emoji.length);
    }
  });

  it('has the pill search field and one category tab per group', async () => {
    await mount();
    expect(search()?.getAttribute('placeholder')).toBe('Search emoji');
    expect(search()?.className).toContain('rounded-full');
    const tabs = [...document.querySelectorAll<HTMLElement>('[data-emoji-category]')];
    expect(tabs.map((t) => t.dataset.emojiCategory)).toEqual(EMOJI_LIST.map((g) => g.name));
    expect(document.querySelector('[data-emoji-categories]')?.className).toContain('lit-float');
  });

  it("search 'fire' shows 🔥 in the results, in place of the grid", async () => {
    await mount();
    await type(search()!, 'fire');
    const results = document.querySelector('[data-emoji-results]');
    expect(results).not.toBeNull();
    expect(cell('🔥', results!)).toBeDefined();
    expect(document.querySelector('[data-emoji-section]')).toBeNull();
    expect(document.querySelector('[data-emoji-categories]')).toBeNull();
  });

  it('a search with no match shows NoResults; Clear search brings the grid back', async () => {
    await mount();
    await type(search()!, 'qqqzzz');
    expect(document.querySelector('[data-emoji-results]')).toBeNull();
    const clear = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Clear search',
    );
    expect(clear).toBeDefined();
    await act(async () => clear?.click());
    expect(document.querySelectorAll('[data-emoji-section]').length).toBe(EMOJI_LIST.length);
  });

  it('a pick calls onPick, then onClose when closeOnPick', async () => {
    const { onPick, onClose } = await mount({ closeOnPick: true });
    await act(async () => cell('👍')?.click());
    expect(onPick).toHaveBeenCalledWith('👍');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a pick keeps the sheet open when closeOnPick is false', async () => {
    const { onPick, onClose } = await mount({ closeOnPick: false });
    await act(async () => cell('🔥')?.click());
    expect(onPick).toHaveBeenCalledWith('🔥');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a pick is recorded to recents and shows under "Frequently used", first', async () => {
    await mount({ closeOnPick: false });
    await act(async () => cell('🎉')?.click());
    expect(readRecents()[0]).toBe('🎉');
    const first = document.querySelector<HTMLElement>('[data-emoji-section]');
    expect(first?.getAttribute('aria-label')).toBe(RECENTS_HEADING);
    expect(cell('🎉', first!)).toBeDefined();
    const firstTab = document.querySelector<HTMLElement>('[data-emoji-category]');
    expect(firstTab?.getAttribute('aria-label')).toBe(RECENTS_HEADING);
  });

  it('reads stored recents on open', async () => {
    window.localStorage.setItem(EMOJI_RECENTS_KEY, JSON.stringify(['🚀']));
    await mount();
    const first = document.querySelector<HTMLElement>('[data-emoji-section]');
    expect(first?.getAttribute('aria-label')).toBe(RECENTS_HEADING);
    expect(cell('🚀', first!)).toBeDefined();
  });

  it('names each emoji button by its first keyword', async () => {
    await mount();
    expect(cell('🔥')?.getAttribute('aria-label')).toBe('fire');
  });

  it('emojiSheetSections: recents first only when there are any', () => {
    expect(emojiSheetSections([]).map((s) => s.key)).toEqual(EMOJI_LIST.map((g) => g.name));
    expect(emojiSheetSections(['🔥'])[0]?.heading).toBe(RECENTS_HEADING);
  });
});
