// @vitest-environment jsdom
// The person card's inline composer: placeholder, reactions while empty, Send
// while typing, the draft kept in the chat drafts store under the card's key,
// and the chat send rule (Enter sends on laptop only).

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  CARD_REACTIONS,
  PersonMessageInput,
  inlineControls,
} from '@/components/ui/PersonMessageInput';
import { QUICK_REACTIONS } from '@/components/chat/MessageActionMenu';
import { getDraft, personDraftKey, resetDrafts, setDraft } from '@/lib/chat/drafts';
import { messagePlaceholder } from '@/lib/person-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LEO = '0190a000-0000-7000-8000-000000000003';
const KEY = personDraftKey(LEO, { kind: 'comment', sourceId: 'c-1' });

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  resetDrafts();
});

async function mount(layout: 'touch' | 'laptop', onSend = vi.fn()): Promise<typeof onSend> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <PersonMessageInput firstName="Leo" draftKey={KEY} layout={layout} onSend={onSend} />,
    );
  });
  return onSend;
}

function input(): HTMLTextAreaElement {
  const el = document.querySelector<HTMLTextAreaElement>('[data-person-message-input]');
  if (el === null) throw new Error('no input');
  return el;
}

function reactions(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-person-reaction]')];
}

function sendButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('[data-person-send]');
}

async function type(value: string): Promise<void> {
  const el = input();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function keydown(key: string, shiftKey = false): Promise<void> {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
  });
}

describe('inlineControls', () => {
  it('reactions while empty (blank counts as empty), Send once there is text', () => {
    expect(inlineControls('')).toEqual({ reactions: true, send: false });
    expect(inlineControls('   ')).toEqual({ reactions: true, send: false });
    expect(inlineControls('hi')).toEqual({ reactions: false, send: true });
  });
});

describe('CARD_REACTIONS', () => {
  it('is the first three of the message menu row (one list, never a copy)', () => {
    expect(CARD_REACTIONS).toEqual(QUICK_REACTIONS.slice(0, 3));
    expect(CARD_REACTIONS).toHaveLength(3);
  });
});

describe('PersonMessageInput', () => {
  it('reads "Message <first name>…" and takes focus on mount', async () => {
    await mount('touch');
    expect(input().placeholder).toBe(messagePlaceholder('Leo'));
    expect(document.activeElement).toBe(input());
  });

  it('empty: the three reactions show inside the box, no Send', async () => {
    await mount('touch');
    expect(reactions().map((b) => b.getAttribute('data-person-reaction'))).toEqual([
      ...CARD_REACTIONS,
    ]);
    expect(sendButton()).toBeNull();
  });

  it('reaction buttons are 44x44 IconButtons', async () => {
    await mount('touch');
    for (const b of reactions()) {
      expect(b.className).toContain('h-11');
      expect(b.className).toContain('w-11');
      expect(b.className).toContain('min-h-11');
    }
  });

  it('typing hides the reactions and shows Send (44px round)', async () => {
    await mount('touch');
    await type('see you');
    expect(reactions()).toHaveLength(0);
    expect(sendButton()).not.toBeNull();
    expect(sendButton()?.className).toContain('h-11');
    expect(getDraft(KEY).text).toBe('see you');
  });

  it('a reaction tap sends the emoji', async () => {
    const onSend = await mount('touch');
    const first = CARD_REACTIONS[0] ?? '';
    await act(async () => reactions()[0]?.click());
    expect(onSend).toHaveBeenCalledWith(first);
  });

  it('a reaction leaves a typed draft as it is', async () => {
    // A kept draft that is only whitespace still shows the reactions.
    setDraft(KEY, { text: '  ', caret: 2 });
    const onSend = await mount('touch');
    await act(async () => reactions()[1]?.click());
    expect(onSend).toHaveBeenCalledWith(CARD_REACTIONS[1]);
    expect(getDraft(KEY).text).toBe('  ');
  });

  it('Send hands over the trimmed text and clears the draft', async () => {
    const onSend = await mount('touch');
    await type('  see you at 3  ');
    await act(async () => sendButton()?.click());
    expect(onSend).toHaveBeenCalledWith('see you at 3');
    expect(getDraft(KEY).text).toBe('');
    expect(input().value).toBe('');
  });

  it('a kept draft paints on mount (reopen the card)', async () => {
    setDraft(KEY, { text: 'half typed', caret: 10 });
    await mount('touch');
    expect(input().value).toBe('half typed');
    expect(sendButton()).not.toBeNull();
  });

  it('touch: Enter is a newline, never a send', async () => {
    const onSend = await mount('touch');
    await type('hello');
    await keydown('Enter');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('laptop: Enter sends, Shift+Enter does not', async () => {
    const onSend = await mount('laptop');
    await type('hello');
    await keydown('Enter', true);
    expect(onSend).not.toHaveBeenCalled();
    await keydown('Enter');
    expect(onSend).toHaveBeenCalledWith('hello');
  });

  it('Enter on an empty box sends nothing', async () => {
    const onSend = await mount('laptop');
    await keydown('Enter');
    expect(onSend).not.toHaveBeenCalled();
  });
});
