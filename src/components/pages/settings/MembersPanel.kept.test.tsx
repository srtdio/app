// @vitest-environment jsdom
// The Members panel kept view: the first open shows "Loading members"; a
// return later in the session (past the cache's window) paints the list read
// last, with no loading line, and the re-read lands while the person has not
// touched the screen; one landing after a touch is held (the next return
// paints it); and the panel's own change lands at once and is what the next
// return paints.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DerivedMembers } from './members-data';
import type { SentInvite } from './MembersInviteForm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  listMembers: vi.fn(),
  readProfiles: vi.fn(),
  onInvited: null as ((sent: readonly SentInvite[]) => void) | null,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: { rpc: async () => ({ data: [], error: null }) },
}));
vi.mock('@srtdio/workspace', () => ({
  listMembers: (...args: unknown[]) => h.listMembers(...args),
}));
vi.mock('@/lib/chat-reads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat-reads')>()),
  readProfiles: (...args: unknown[]) => h.readProfiles(...args),
}));
vi.mock('@/lib/session-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session-context')>()),
  useSession: () => ({ session: { user: { id: 'u1', email: 'zara@example.com' } } }),
}));
vi.mock('@/lib/workspace-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-context')>()),
  useWorkspace: () => ({
    workspaceId: 'ws-1',
    workspaceName: 'Acme',
    workspaceDisplayName: 'Acme',
  }),
}));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/components/ui/toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/toast')>()),
  useToast: () => ({ show: () => undefined }),
}));
vi.mock('./MembersList', () => ({
  MembersList: ({ derived }: { derived: DerivedMembers }) => (
    <div data-members-list="">
      {[...derived.agency, ...derived.client].map((m) => m.displayName).join(',')}
    </div>
  ),
}));
vi.mock('./MembersInviteForm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./MembersInviteForm')>()),
  MembersInviteForm: ({ onInvited }: { onInvited: (sent: readonly SentInvite[]) => void }) => {
    h.onInvited = onInvited;
    return null;
  },
}));
vi.mock('./MemberActionSheet', () => ({ MemberActionSheet: () => null }));

import { MembersPanel } from './MembersPanel';
import { MEMBERS_STALE_MS, resetWorkspaceMembersCache } from '@/lib/workspace-members';
import type { WorkspaceMemberRow } from '@/lib/workspace-members';
import { resetSessionReads } from '@/lib/session-read';

const LOADING_LINE = 'Loading members';

function row(userId: string, role: string): WorkspaceMemberRow {
  return {
    accepted_at: '2026-09-01T00:00:00Z',
    active: true,
    id: `m-${userId}`,
    invited_at: '2026-09-01T00:00:00Z',
    invited_by: null,
    join_default_group: false,
    rejoined_at: null,
    removed_at: null,
    role,
    user_id: userId,
    workspace_id: 'ws-1',
  };
}

const ROWS = [row('u1', 'owner'), row('u2', 'client')];

function profiles(clientName: string) {
  return [
    { userId: 'u1', displayName: 'Zara', avatarUrl: null, username: null },
    { userId: 'u2', displayName: clientName, avatarUrl: null, username: null },
  ];
}

let root: Root | null = null;

function render(): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(<MembersPanel />));
}

function unmount(): void {
  act(() => root?.unmount());
  root = null;
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
}

function text(): string {
  return document.body.textContent ?? '';
}

/** The next members read, answered by hand. */
function heldMembers(): () => void {
  let answer: () => void = () => undefined;
  h.listMembers.mockReturnValueOnce(
    new Promise((resolve) => {
      answer = () => resolve({ ok: true, data: ROWS });
    }),
  );
  return answer;
}

/** The first open (Asha), then leave and come back past the cache's window. */
async function openThenReturnLater(): Promise<void> {
  render();
  expect(text()).toContain(LOADING_LINE);
  await settle();
  expect(text()).toContain('Asha');
  unmount();
  vi.setSystemTime(new Date(Date.now() + MEMBERS_STALE_MS + 1));
  h.readProfiles.mockResolvedValue({ ok: true, data: profiles('Bea') });
}

beforeEach(() => {
  resetWorkspaceMembersCache();
  resetSessionReads();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-26T10:00:00.000Z'));
  h.onInvited = null;
  h.listMembers.mockReset().mockResolvedValue({ ok: true, data: ROWS });
  h.readProfiles.mockReset().mockResolvedValue({ ok: true, data: profiles('Asha') });
});

afterEach(() => {
  unmount();
  document.body.innerHTML = '';
  resetWorkspaceMembersCache();
  resetSessionReads();
  vi.useRealTimers();
});

describe('Members panel: a return paints the kept list', () => {
  it('paints the last list with no loading line, then the re-read lands untouched', async () => {
    await openThenReturnLater();
    const answer = heldMembers();
    render();
    expect(text()).not.toContain(LOADING_LINE);
    expect(text()).toContain('Asha');
    expect(h.listMembers).toHaveBeenCalledTimes(2);
    await act(async () => answer());
    await settle();
    expect(text()).not.toContain(LOADING_LINE);
    expect(text()).toContain('Bea');
  });

  it('a re-read landing after a touch is held; the next return paints it', async () => {
    await openThenReturnLater();
    const answer = heldMembers();
    render();
    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });
    await act(async () => answer());
    await settle();
    expect(text()).toContain('Asha');
    expect(text()).not.toContain('Bea');
    unmount();
    render();
    expect(text()).not.toContain(LOADING_LINE);
    expect(text()).toContain('Bea');
  });

  it("the panel's own change lands at once, even after a touch, and is what a return paints", async () => {
    await openThenReturnLater();
    h.readProfiles.mockResolvedValue({ ok: true, data: profiles('Asha') });
    render();
    await settle();
    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });
    h.readProfiles.mockResolvedValue({ ok: true, data: profiles('Cara') });
    act(() => h.onInvited?.([]));
    await settle();
    expect(text()).toContain('Cara');
    unmount();
    vi.setSystemTime(new Date(Date.now() + MEMBERS_STALE_MS + 1));
    heldMembers();
    render();
    expect(text()).not.toContain(LOADING_LINE);
    expect(text()).toContain('Cara');
  });
});
