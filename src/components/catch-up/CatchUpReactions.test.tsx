// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CATCH_UP_REACT_CLASS,
  CatchUpRowReactions,
  reactionKindOf,
} from '@/components/catch-up/CatchUpReactions';
import type { ReactionsApi } from '@/lib/reactions/use-reactions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const read = (rel: string): string => readFileSync(resolve(__dirname, rel), 'utf8');

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function api(list: { emoji: string; count: number; mine: boolean }[]): ReactionsApi {
  return {
    of: () => list,
    rowsOf: () => [],
    toggle: vi.fn(),
    pick: vi.fn(),
    me: 'me',
  };
}

async function mount(a: ReactionsApi): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<CatchUpRowReactions id="m1" api={a} workspaceId="w" />);
    await new Promise((r) => setTimeout(r, 20));
  });
  return host;
}

describe('catch-up reactions', () => {
  it('reads the right table per card kind', () => {
    expect(reactionKindOf('post')).toBe('comment');
    expect(reactionKindOf('brief')).toBe('comment');
    expect(reactionKindOf('plan-item')).toBe('plan-comment');
    expect(reactionKindOf('idea')).toBe('plan-comment');
    expect(reactionKindOf('chat-main')).toBe('chat');
    expect(reactionKindOf('chat-thread')).toBe('chat');
  });

  it('no reactions: the smiley alone in the corner, out of the flow (no chip row)', async () => {
    const host = await mount(api([]));
    expect(host.querySelector('[data-reaction-chips]')).toBeNull();
    const add = host.querySelector('[data-reaction-add]');
    expect(add?.getAttribute('aria-label')).toBe('Add reaction');
    expect(CATCH_UP_REACT_CLASS.split(' ')).toContain('absolute');
  });

  it('a chip tap toggles the reaction and does nothing else (never marks read)', async () => {
    const a = api([{ emoji: '👍', count: 1, mine: false }]);
    const host = await mount(a);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-reaction-chip]')?.click());
    expect(a.toggle).toHaveBeenCalledWith('m1', '👍');
    const src = read('./CatchUpReactions.tsx');
    expect(src).not.toContain('@/lib/catch-up/writes');
    // Nothing that marks read or moves the stack is reachable from here.
    expect(src).not.toMatch(/from '@\/lib\/catch-up\/(writes|use-catch-up|route)'/);
    expect(src).not.toContain('inbox_mark');
  });

  it('one batched read per card body and per thread view (no N+1)', () => {
    expect(read('./CatchUpCard.tsx').match(/useCatchUpReactions\(/g)?.length).toBe(1);
    expect(read('./CatchUpThreadView.tsx').match(/useCatchUpReactions\(/g)?.length).toBe(1);
    expect(read('./CatchUpRows.tsx')).not.toContain('useReactions');
  });
});
