// @vitest-environment jsdom
// The approve sheets' approvers (useWorkspaceApprovers) and the Pipeline's
// people (useWorkspacePeople) read through the session-shared members cache
// (src/lib/workspace-members.ts): mounted together, with Settings' members
// panel, they cost one membership read and one profile read between them.
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  listMembers: vi.fn(),
  readProfiles: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@srtdio/workspace', () => ({
  listMembers: (...args: unknown[]) => h.listMembers(...args),
}));
vi.mock('@/lib/chat-reads', () => ({
  readProfiles: (...args: unknown[]) => h.readProfiles(...args),
}));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'user-a' } }, loading: false }),
}));

import { useWorkspaceApprovers } from '@/components/pages/pcs/use-approvers';
import { useWorkspacePeople } from '@/components/pages/pipeline/use-workspace-people';
import {
  MEMBERS_STALE_MS,
  resetWorkspaceMembersCache,
  useWorkspaceMembers,
} from '@/lib/workspace-members';
import { resetSessionReads } from '@/lib/session-read';

const ROWS = [
  { user_id: 'u-owner', role: 'owner', active: true, removed_at: null },
  { user_id: 'u-client', role: 'client', active: true, removed_at: null },
  { user_id: 'u-gone', role: 'client', active: false, removed_at: '2026-09-01T00:00:00Z' },
];
const PROFILES = [
  { userId: 'u-owner', displayName: 'Omar Owner', avatarUrl: null },
  { userId: 'u-client', displayName: 'Cleo Client', avatarUrl: null },
  { userId: 'u-gone', displayName: 'Gil Gone', avatarUrl: null },
];

const approvers: unknown[][] = [];
const people: { approverFirstNames: string[]; names: ReadonlyMap<string, string> }[] = [];

function Approvers(): ReactElement {
  approvers.push(useWorkspaceApprovers('ws-1'));
  return createElement('span');
}

function People(): ReactElement {
  people.push(useWorkspacePeople('ws-1'));
  return createElement('span');
}

function SettingsMembers(): ReactElement {
  useWorkspaceMembers('ws-1');
  return createElement('span');
}

let roots: Root[] = [];

function mount(node: ReactElement): void {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  act(() => root.render(node));
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  h.listMembers.mockReset();
  h.readProfiles.mockReset();
  h.listMembers.mockImplementation(async () => ({ ok: true, data: ROWS }));
  h.readProfiles.mockImplementation(async () => ({ ok: true, data: PROFILES }));
  resetWorkspaceMembersCache();
  // Each read is also a session read: none is kept between tests.
  resetSessionReads();
  approvers.length = 0;
  people.length = 0;
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('approvers and people share the workspace members read', () => {
  it('approve sheet, Pipeline and Settings mounted together: one listMembers, one readProfiles', async () => {
    mount(
      createElement('div', null, [
        createElement(Approvers, { key: 'a' }),
        createElement(Approvers, { key: 'b' }),
        createElement(People, { key: 'p' }),
        createElement(SettingsMembers, { key: 's' }),
      ]),
    );
    await flush();
    expect(h.listMembers).toHaveBeenCalledTimes(1);
    expect(h.readProfiles).toHaveBeenCalledTimes(1);
    expect(approvers[approvers.length - 1]).toEqual([{ userId: 'u-client', name: 'Cleo Client' }]);
    const last = people[people.length - 1]!;
    expect(last.approverFirstNames).toEqual(['Cleo']);
    // Only active members' names, as before (the removed client is not named).
    expect(last.names.has('u-gone')).toBe(false);
    expect(last.names.get('u-owner')).toBe('Omar Owner');
  });

  it('a later mount within the window reads nothing more', async () => {
    mount(createElement(People));
    await flush();
    mount(createElement(Approvers));
    await flush();
    expect(h.listMembers).toHaveBeenCalledTimes(1);
    expect(approvers[0]).toEqual([{ userId: 'u-client', name: 'Cleo Client' }]);
  });

  it('never paints a list that then changes: empty while loading, then the final list', async () => {
    mount(createElement(Approvers));
    await flush();
    const firstNonEmpty = approvers.findIndex((list) => list.length > 0);
    expect(approvers.slice(0, firstNonEmpty).every((list) => list.length === 0)).toBe(true);
    expect(approvers.slice(firstNonEmpty).every((list) => list.length === 1)).toBe(true);
  });

  it('a cache older than MEMBERS_STALE_MS is not shown: the next mount loads again', async () => {
    mount(createElement(Approvers));
    await flush();
    for (const root of roots) act(() => root.unmount());
    roots = [];
    const later = Date.now() + MEMBERS_STALE_MS + 1;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    h.listMembers.mockImplementation(() => new Promise(() => {}));
    approvers.length = 0;
    mount(createElement(Approvers));
    // The re-read is running: what is shown is the loading (empty) list, not the old one.
    expect(h.listMembers).toHaveBeenCalledTimes(2);
    expect(approvers[approvers.length - 1]).toEqual([]);
  });

  it('a failed read leaves the lists empty', async () => {
    h.listMembers.mockImplementation(async () => ({ ok: false, error: { message: 'boom' } }));
    mount(
      createElement('div', null, [
        createElement(Approvers, { key: 'a' }),
        createElement(People, { key: 'p' }),
      ]),
    );
    await flush();
    expect(approvers[approvers.length - 1]).toEqual([]);
    expect(people[people.length - 1]!.approverFirstNames).toEqual([]);
  });
});
