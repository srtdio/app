// @vitest-environment jsdom
// X7 fix 3 (FB3, FT47): the New chat sheet guards a typed group name or picked
// people. System Back asks "Discard this chat?" and Keep editing keeps the
// picks; Create group / Start chat are never disabled without a reason.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-x7' }));
vi.mock('@/components/chat/chat-actions', () => ({
  createGroupChannel: vi.fn(async () => null),
  startDmChannel: vi.fn(async () => null),
}));
vi.mock('@/lib/workspace-members', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-members')>()),
  useWorkspaceMembers: () => ({
    options: [
      { userId: 'me', displayName: 'Me', avatarUrl: null },
      { userId: 'u2', displayName: 'Asha Rao', avatarUrl: null },
    ],
    loading: false,
    error: null,
  }),
}));

import {
  NAME_THE_GROUP,
  NEW_CHAT_DISCARD,
  NewChatSheet,
  PICK_SOMEONE,
  newChatDirty,
  newChatMissing,
} from '@/components/chat/NewChatSheet';
import { BACK_GUARD_STEP_KEY } from '@/lib/back-guard';
import { resetHistorySteps, stepMarkerOf } from '@/lib/chat/use-history-step';
import { DUR_BASE_MS } from '@/lib/motion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => act(async () => wait(60));
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  );
const memberRow = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find((b) =>
    b.textContent?.includes(name),
  );
const confirm = () => document.querySelector<HTMLElement>('[role="alertdialog"]');

async function mount() {
  const onClose = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <NewChatSheet
        open
        onClose={onClose}
        workspaceId="ws"
        currentUserId="me"
        onDmReady={vi.fn()}
        onGroupCreated={vi.fn()}
      />,
    );
  });
  await settle();
  return { onClose };
}

beforeEach(() => resetHistorySteps());

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  await settle();
  resetHistorySteps();
});

describe('X7 New chat: dirty guard and inline reasons', () => {
  it('pure rules: dirty on a name or any pick; the reason a tap cannot go', () => {
    expect(newChatDirty({ name: '', selectedIds: [], peerId: null })).toBe(false);
    expect(newChatDirty({ name: 'Launch', selectedIds: [], peerId: null })).toBe(true);
    expect(newChatDirty({ name: '', selectedIds: ['u2'], peerId: null })).toBe(true);
    expect(newChatDirty({ name: '', selectedIds: [], peerId: 'u2' })).toBe(true);
    expect(newChatMissing('dm', { name: '', selectedIds: [], peerId: null })).toBe(PICK_SOMEONE);
    expect(newChatMissing('group', { name: ' ', selectedIds: ['u2'], peerId: null })).toBe(
      NAME_THE_GROUP,
    );
    expect(newChatMissing('group', { name: 'Launch', selectedIds: [], peerId: null })).toBe(
      PICK_SOMEONE,
    );
    expect(newChatMissing('group', { name: 'Launch', selectedIds: ['u2'], peerId: null })).toBe(
      null,
    );
    expect(NEW_CHAT_DISCARD).toEqual({
      title: 'Discard this chat?',
      message: 'Your group name and picked people will be lost.',
    });
  });

  it('New chat with picks then system Back asks and keeps picks', async () => {
    const { onClose } = await mount();
    await act(async () => button('New group')?.click());
    await act(async () => memberRow('Asha Rao')?.click());
    expect(memberRow('Asha Rao')?.getAttribute('aria-pressed')).toBe('true');
    await settle();
    expect(stepMarkerOf(window.history.state, BACK_GUARD_STEP_KEY)).not.toBeNull();

    await act(async () => {
      window.history.back();
      await wait(60);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(confirm()?.textContent).toContain('Discard this chat?');
    expect(confirm()?.textContent).toContain('Your group name and picked people will be lost.');

    await act(async () => {
      button('Keep editing')?.click();
      await wait(DUR_BASE_MS + 40);
    });
    expect(confirm()).toBeNull();
    // Kept: the sheet is still on New group with the pick in place.
    expect(memberRow('Asha Rao')?.getAttribute('aria-pressed')).toBe('true');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Create group is never disabled for a missing input: a tap says what is missing', async () => {
    await mount();
    await act(async () => button('New group')?.click());
    const create = button('Create group');
    expect(create?.disabled).toBe(false);
    await act(async () => create?.click());
    expect(document.querySelector('[data-new-chat-missing]')?.textContent).toBe(NAME_THE_GROUP);
  });

  it('Start chat with no one picked says "Pick at least one person"', async () => {
    await mount();
    await act(async () => button('New direct message')?.click());
    const start = button('Start chat');
    expect(start?.disabled).toBe(false);
    await act(async () => start?.click());
    expect(document.querySelector('[data-new-chat-missing]')?.textContent).toBe(PICK_SOMEONE);
  });
});
