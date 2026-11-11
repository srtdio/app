// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AddReactionSheet,
  REACTION_PILL_CLASS,
  REACTION_PILL_MINE,
  REACTION_PILL_OTHERS,
  ReactionChips,
  namesByEmoji,
} from '@/components/ui/ReactionChips';
import EmojiSheet, { EMOJI_SHEET_TITLE } from '@/components/ui/EmojiSheet';
import { readRecents } from '@/lib/chat/emoji-list';

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
    // Blocked storage.
  }
});

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(node);
    await wait(20);
  });
  return host;
}

const two = [
  { emoji: '👍', count: 3, mine: true },
  { emoji: '❤️', count: 1, mine: false },
];

describe('ReactionChips', () => {
  it('draws others and mine, in order, then the smiley pill last', async () => {
    const host = await mount(
      <ReactionChips reactions={two} onToggle={() => {}} onPick={() => {}} />,
    );
    const row = host.querySelector('[data-reaction-chips]');
    const buttons = [...(row?.querySelectorAll('button') ?? [])];
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      '👍 3, you reacted',
      '❤️ 1',
      'Add reaction',
    ]);
    const [mine, others, add] = buttons;
    expect(mine?.getAttribute('aria-pressed')).toBe('true');
    expect(others?.getAttribute('aria-pressed')).toBe('false');
    for (const c of REACTION_PILL_MINE.split(' ')) expect(mine?.className).toContain(c);
    for (const c of REACTION_PILL_OTHERS.split(' ')) expect(others?.className).toContain(c);
    expect(add?.hasAttribute('data-reaction-add')).toBe(true);
    expect(add?.className).toContain('w-10');
  });

  it('pills are 32 tall with a 44 tap from the pseudo-element, never a taller pill', () => {
    const t = REACTION_PILL_CLASS.split(' ');
    expect(t).toEqual(
      expect.arrayContaining(['h-8', 'rounded-full', 'border', 'before:-inset-y-1.5']),
    );
    expect(t.some((c) => /^(min-)?h-(9|10|11|12)$/.test(c))).toBe(false);
  });

  it('a pill tap toggles that emoji', async () => {
    const onToggle = vi.fn();
    const host = await mount(
      <ReactionChips reactions={two} onToggle={onToggle} onPick={() => {}} />,
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-reaction-chip="❤️"]')?.click(),
    );
    expect(onToggle).toHaveBeenCalledWith('❤️');
  });

  it('no reactions: nothing renders', async () => {
    const empty = await mount(
      <ReactionChips reactions={[]} onToggle={() => {}} onPick={() => {}} />,
    );
    expect(empty.querySelector('[data-reaction-chips]')).toBeNull();
  });

  it('the smiley opens the one drawer titled "Add reaction"; a pick adds and feeds Frequently used', async () => {
    const onPick = vi.fn();
    const host = await mount(<ReactionChips reactions={two} onToggle={() => {}} onPick={onPick} />);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-reaction-add]')?.click());
    for (let i = 0; i < 50 && document.querySelector('[data-emoji-sheet]') === null; i += 1) {
      await act(async () => wait(20));
    }
    expect(document.querySelector('[data-emoji-sheet]')).not.toBeNull();
    expect(document.body.textContent).toContain('Add reaction');
    const cell = document.querySelector<HTMLButtonElement>('[data-emoji-cell]');
    const emoji = cell?.dataset.emojiCell ?? '';
    await act(async () => cell?.click());
    expect(onPick).toHaveBeenCalledWith(emoji);
    expect(readRecents()[0]).toBe(emoji);
  });

  it('the composer keeps the "Emoji" title (the default); reactions say "Add reaction"', async () => {
    await mount(<EmojiSheet open onClose={() => {}} onPick={() => {}} closeOnPick />);
    expect(EMOJI_SHEET_TITLE).toBe('Emoji');
    expect(document.body.textContent).toContain('Emoji');
    expect(document.body.textContent).not.toContain('Add reaction');
    act(() => root?.unmount());
    document.body.innerHTML = '';
    await mount(<AddReactionSheet open onClose={() => {}} onPick={() => {}} />);
    for (let i = 0; i < 50 && document.querySelector('[data-emoji-sheet]') === null; i += 1) {
      await act(async () => wait(20));
    }
    expect(document.body.textContent).toContain('Add reaction');
  });

  it('who reacted: names per emoji, the viewer first as "You"', () => {
    const names = namesByEmoji(
      {
        rows: [
          { userId: 'a', emoji: '👍', createdAt: 't' },
          { userId: 'me', emoji: '👍', createdAt: 't' },
        ],
        profiles: new Map([['a', { userId: 'a', displayName: 'Ana', avatarUrl: null }]]),
        former: new Set(),
      },
      'me',
    );
    expect(names.get('👍')).toEqual(['You', 'Ana']);
  });
});

describe("ReactionChips addWhenEmpty (a thread's main message)", () => {
  it('default: no reactions, nothing renders', async () => {
    const host = await mount(
      <ReactionChips reactions={[]} onToggle={() => {}} onPick={() => {}} />,
    );
    expect(host.querySelector('[data-reaction-chips]')).toBeNull();
  });

  it('opt-in: no reactions, the smiley key alone; with reactions, chips then the same key', async () => {
    const host = await mount(
      <ReactionChips reactions={[]} addWhenEmpty onToggle={() => {}} onPick={() => {}} />,
    );
    const buttons = [...host.querySelectorAll('[data-reaction-chips] button')];
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Add reaction']);
    expect(buttons[0]?.hasAttribute('data-reaction-add')).toBe(true);
    act(() => root?.unmount());
    const withChips = await mount(
      <ReactionChips reactions={two} addWhenEmpty onToggle={() => {}} onPick={() => {}} />,
    );
    expect(withChips.querySelectorAll('[data-reaction-add]')).toHaveLength(1);
    expect(withChips.querySelectorAll('[data-reaction-chip]')).toHaveLength(2);
  });

  it('opt-in but the viewer cannot react: nothing renders', async () => {
    const host = await mount(
      <ReactionChips
        reactions={[]}
        addWhenEmpty
        canReact={false}
        onToggle={() => {}}
        onPick={() => {}}
      />,
    );
    expect(host.querySelector('[data-reaction-chips]')).toBeNull();
  });
});
