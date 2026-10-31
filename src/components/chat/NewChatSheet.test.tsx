// @vitest-environment jsdom
// One chat group per workspace (free plan). The New chat sheet reads the cached
// 'group.create_more' capability (no new read): false greys New group with a
// note; the owner also gets Contact us / Book a call, anyone else is told whom
// to ask. null (not read yet) and true leave the sheet as it was. A
// group_create refused with group_limit_reached shows the same blocked state
// and drops only that one capability from the cache.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  cap: null as boolean | null,
  ownerId: 'owner',
  failure: null as { code: string; message: string } | null,
  profiles: new Map<string, { userId: string; displayName: string; avatarUrl: null }>(),
  drop: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-limit' }));
vi.mock('@/components/chat/chat-actions', () => ({
  createGroupChannel: vi.fn(async () => h.failure),
  startDmChannel: vi.fn(async () => null),
}));
vi.mock('@/lib/workspace-members', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-members')>()),
  useWorkspaceMembers: () => ({
    options: [
      { userId: 'owner', displayName: 'Priya Shah', avatarUrl: null },
      { userId: 'me', displayName: 'Me', avatarUrl: null },
      { userId: 'u2', displayName: 'Asha Rao', avatarUrl: null },
    ],
    profiles: h.profiles,
    rows: [],
    loading: false,
    error: null,
  }),
}));
vi.mock('@/lib/workspace-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-context')>()),
  useWorkspace: () => ({
    workspaceId: 'ws',
    workspaceDisplayName: 'Acme - LinkedIn',
    workspaces: [{ id: 'ws', owner_user_id: h.ownerId }],
  }),
}));
vi.mock('@/lib/workspace-context-capability', () => ({
  useWorkspaceCapability: (key: string) => (key === 'group.create_more' ? h.cap : null),
  dropCachedCapability: h.drop,
}));

import {
  GROUP_LIMIT_OWNER,
  GROUP_LIMIT_OWNER_FALLBACK,
  NEW_GROUP_FAILED,
  NewChatSheet,
  groupLimitMemberCopy,
  newGroupBlocked,
} from '@/components/chat/NewChatSheet';
import { ContactSheet } from '@/components/support/ContactSheet';
import { moreGroupsRequest } from '@/lib/support';
import { resetHistorySteps } from '@/lib/chat/use-history-step';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => act(async () => wait(60));
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')];
const button = (label: string) => buttons().find((b) => b.textContent?.trim() === label);
const buttonWith = (label: string) => buttons().find((b) => b.textContent?.includes(label));
const note = () => document.querySelector<HTMLElement>('[data-group-limit-note]');
const groupRow = () => document.querySelector<HTMLButtonElement>('[data-new-group-row]');

async function mount(currentUserId: string) {
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
        currentUserId={currentUserId}
        onDmReady={vi.fn()}
        onGroupCreated={vi.fn()}
      />,
    );
  });
  await settle();
  return { onClose };
}

async function typeName(value: string) {
  const input = document.querySelector<HTMLInputElement>('[id="new-group-name"]');
  if (!input) throw new Error('no group name input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  resetHistorySteps();
  h.cap = null;
  h.ownerId = 'owner';
  h.failure = null;
  h.profiles = new Map([
    ['owner', { userId: 'owner', displayName: 'Priya Shah', avatarUrl: null }],
  ]);
  h.drop.mockReset();
});

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  await settle();
  resetHistorySteps();
});

describe('group limit copy (pure)', () => {
  it('owner note and member note, with the owner fallback', () => {
    expect(GROUP_LIMIT_OWNER).toBe(
      'On the free plan a workspace has one group. Need another? Talk to us.',
    );
    expect(groupLimitMemberCopy('Priya Shah')).toBe(
      'This workspace has one group. Ask Priya Shah about adding more.',
    );
    expect(groupLimitMemberCopy(null)).toBe(
      'This workspace has one group. Ask the workspace owner about adding more.',
    );
    expect(groupLimitMemberCopy('  ')).toContain(GROUP_LIMIT_OWNER_FALLBACK);
  });

  it('only false or a server refusal blocks', () => {
    expect(newGroupBlocked(null, false)).toBe(false);
    expect(newGroupBlocked(true, false)).toBe(false);
    expect(newGroupBlocked(false, false)).toBe(true);
    expect(newGroupBlocked(true, true)).toBe(true);
  });
});

describe('New chat sheet: New group blocked', () => {
  it('owner: New group greyed, the free-plan note, Contact us and Book a call', async () => {
    h.cap = false;
    const { onClose } = await mount('owner');
    const row = groupRow();
    expect(row?.disabled).toBe(true);
    expect(row?.getAttribute('aria-describedby')).toBe('group-limit-note');
    expect(note()?.id).toBe('group-limit-note');
    expect(note()?.textContent).toBe(GROUP_LIMIT_OWNER);
    expect(buttonWith('Contact us')).toBeDefined();
    expect(buttonWith('Book a call')).toBeDefined();

    await act(async () => buttonWith('Contact us')?.click());
    await settle();
    // One sheet at a time: the New chat sheet closes, Write to us opens.
    expect(onClose).toHaveBeenCalled();
    expect(document.body.textContent).toContain("Hi, we'd like more groups in Acme - LinkedIn.");
  });

  it('non-owner: the owner-name line, no support rows', async () => {
    h.cap = false;
    await mount('me');
    expect(groupRow()?.disabled).toBe(true);
    expect(note()?.textContent).toBe(
      'This workspace has one group. Ask Priya Shah about adding more.',
    );
    expect(buttonWith('Contact us')).toBeUndefined();
    expect(buttonWith('Book a call')).toBeUndefined();
  });

  it('non-owner with the owner not in the members cache: "the workspace owner"', async () => {
    h.cap = false;
    h.profiles = new Map();
    await mount('me');
    expect(note()?.textContent).toBe(
      'This workspace has one group. Ask the workspace owner about adding more.',
    );
  });

  it.each([null, true])('capability %s: New group works as before', async (cap) => {
    h.cap = cap;
    await mount('owner');
    expect(groupRow()?.disabled).toBe(false);
    expect(groupRow()?.hasAttribute('aria-describedby')).toBe(false);
    expect(note()).toBeNull();
    await act(async () => button('New group')?.click());
    expect(document.querySelector('[id="new-group-name"]')).not.toBeNull();
  });
});

describe('New chat sheet: server backstop', () => {
  async function createRefused(message: string) {
    h.cap = true;
    h.failure = { code: 'unknown', message };
    await mount('owner');
    await act(async () => button('New group')?.click());
    await typeName('Launch');
    await act(async () => buttonWith('Asha Rao')?.click());
    await act(async () => button('Create group')?.click());
    await settle();
  }

  it('group_limit_reached: back to choose, blocked, no failure line, one cache entry dropped', async () => {
    await createRefused('group_limit_reached');
    expect(document.body.textContent).not.toContain(NEW_GROUP_FAILED);
    expect(document.querySelector('[id="new-group-name"]')).toBeNull();
    expect(groupRow()?.disabled).toBe(true);
    expect(note()?.textContent).toBe(GROUP_LIMIT_OWNER);
    expect(h.drop).toHaveBeenCalledOnce();
    expect(h.drop).toHaveBeenCalledWith('owner', 'ws', 'group.create_more');
  });

  it('any other failure keeps the fixed failure line', async () => {
    await createRefused('group_name_taken');
    expect(document.body.textContent).toContain(NEW_GROUP_FAILED);
    expect(h.drop).not.toHaveBeenCalled();
  });
});

describe('ContactSheet request prop', () => {
  it('shows the caller suggested line and mailto', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <ContactSheet
          open
          onClose={() => undefined}
          workspaceName="Acme - LinkedIn"
          request={moreGroupsRequest('Acme - LinkedIn')}
        />,
      );
    });
    await settle();
    const text = document.body.textContent ?? '';
    expect(text).toContain("Hi, we'd like more groups in Acme - LinkedIn.");
    expect(text).not.toContain('need another workspace');
    const mail = [...document.querySelectorAll('a')].find((a) => a.textContent === 'Open email');
    expect(mail?.getAttribute('href')).toContain(
      'subject=More%20groups%20for%20Acme%20-%20LinkedIn',
    );
  });
});
