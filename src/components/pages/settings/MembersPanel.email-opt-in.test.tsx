// @vitest-environment jsdom
// A manager's Catch-up emails tick in the member sheet: the held member entry
// is patched before member_email_opt_in_set answers (the list's mail tag and
// the open sheet change in the same frame), the call carries the member, the
// value and a trace id and never the caller, a failure reverts, and
// turned_off_by_member lands the "off by the person" state.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DerivedMembers, MemberEntry } from './members-data';
import type { MemberEmailOptInHandler, SheetPerson } from './MemberActionSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface SheetProps {
  member: MemberEntry | null;
  viewerId: string | null;
  onSetEmailOptIn: MemberEmailOptInHandler;
  personFor: (userId: string) => SheetPerson | null;
}

const h = vi.hoisted(() => ({
  listMembers: vi.fn(),
  readProfiles: vi.fn(),
  rpc: vi.fn(),
  openSheet: null as ((member: MemberEntry) => void) | null,
  sheet: null as SheetProps | null,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => h.rpc(...args) },
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
vi.mock('./MembersList', async () => {
  const { memberEmailTag } = await import('./members-data');
  return {
    MembersList: ({
      derived,
      canManage,
      onChangeRole,
    }: {
      derived: DerivedMembers;
      canManage: boolean;
      onChangeRole: (member: MemberEntry) => void;
    }) => {
      h.openSheet = onChangeRole;
      return (
        <div>
          {[...derived.agency, ...derived.client].map((m) => (
            <span key={m.id} data-tag-for={m.userId}>
              {memberEmailTag(m, canManage) ?? ''}
            </span>
          ))}
        </div>
      );
    },
  };
});
vi.mock('./MembersInviteForm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./MembersInviteForm')>()),
  MembersInviteForm: () => null,
}));
vi.mock('./MemberActionSheet', () => ({
  MemberActionSheet: (props: SheetProps) => {
    h.sheet = props;
    return null;
  },
}));

import { MembersPanel, missingOffByIds, withEmailPatches } from './MembersPanel';
import { resetWorkspaceMembersCache } from '@/lib/workspace-members';
import type { WorkspaceMemberRow } from '@/lib/workspace-members';
import { resetSessionReads } from '@/lib/session-read';

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

const PROFILES = [
  { userId: 'u1', displayName: 'Zara', avatarUrl: null, emailOptIn: true, emailOptOutBy: null },
  { userId: 'u2', displayName: 'Asha', avatarUrl: null, emailOptIn: true, emailOptOutBy: null },
];

let root: Root | null = null;

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
}

async function openAshaSheet(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(<MembersPanel />));
  await settle();
  act(() =>
    h.openSheet?.({
      id: 'm-u2',
      userId: 'u2',
      role: 'client',
      displayName: 'Asha',
      avatarUrl: null,
      email: null,
      acceptedAt: '2026-09-01T00:00:00Z',
      isOwner: false,
      isSelf: false,
      emailOptIn: true,
      emailOptOutBy: null,
    }),
  );
}

function tag(userId: string): string {
  return document.querySelector(`[data-tag-for="${userId}"]`)?.textContent ?? '';
}

/** The next rpc call, answered by hand. */
function heldRpc(): (error: { message: string } | null) => void {
  let answer: (error: { message: string } | null) => void = () => undefined;
  h.rpc.mockReturnValueOnce(
    new Promise((resolve) => {
      answer = (error) => resolve({ data: error === null ? 'u2' : null, error });
    }),
  );
  return answer;
}

beforeEach(() => {
  resetWorkspaceMembersCache();
  resetSessionReads();
  h.openSheet = null;
  h.sheet = null;
  h.rpc.mockReset();
  h.listMembers.mockReset().mockResolvedValue({ ok: true, data: [row('u1', 'owner'), row('u2', 'client')] });
  h.readProfiles.mockReset().mockResolvedValue({ ok: true, data: PROFILES });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  resetWorkspaceMembersCache();
  resetSessionReads();
});

describe('Members panel: catch-up emails from the member sheet', () => {
  it('patches the tag and the sheet before the call answers; sends member, value and trace only', async () => {
    await openAshaSheet();
    expect(tag('u2')).toBe('on');
    const answer = heldRpc();
    let outcome: Promise<string> | null = null;
    act(() => {
      outcome = h.sheet!.onSetEmailOptIn(h.sheet!.member!, false);
    });
    // Same frame: no wait on the call.
    expect(tag('u2')).toBe('off');
    expect(h.sheet!.member).toMatchObject({ emailOptIn: false, emailOptOutBy: 'u1' });
    expect(h.sheet!.personFor('u1')).toEqual({ userId: 'u1', name: 'Zara', avatarUrl: null });
    expect(h.rpc).toHaveBeenCalledWith('member_email_opt_in_set', {
      p_user_id: 'u2',
      p_email_opt_in: false,
      p_trace_id: 'trace-1',
    });
    await act(async () => answer(null));
    await expect(outcome!).resolves.toBe('saved');
    expect(tag('u2')).toBe('off');
  });

  it('a failure puts the held value back', async () => {
    await openAshaSheet();
    const answer = heldRpc();
    let outcome: Promise<string> | null = null;
    act(() => {
      outcome = h.sheet!.onSetEmailOptIn(h.sheet!.member!, false);
    });
    expect(tag('u2')).toBe('off');
    await act(async () => answer({ message: 'forbidden' }));
    await expect(outcome!).resolves.toBe('failed');
    expect(tag('u2')).toBe('on');
    expect(h.sheet!.member).toMatchObject({ emailOptIn: true, emailOptOutBy: null });
  });

  it('turned_off_by_member lands the off-by-the-person state', async () => {
    await openAshaSheet();
    const answer = heldRpc();
    let outcome: Promise<string> | null = null;
    act(() => {
      outcome = h.sheet!.onSetEmailOptIn(h.sheet!.member!, true);
    });
    await act(async () => answer({ message: 'turned_off_by_member' }));
    await expect(outcome!).resolves.toBe('turned_off_by_member');
    expect(tag('u2')).toBe('off');
    expect(h.sheet!.member).toMatchObject({ emailOptIn: false, emailOptOutBy: null });
  });
});

describe('withEmailPatches / missingOffByIds', () => {
  const entry = (userId: string, extra: Partial<MemberEntry> = {}): MemberEntry => ({
    id: `m-${userId}`,
    userId,
    role: 'agency',
    displayName: userId,
    avatarUrl: null,
    email: null,
    acceptedAt: null,
    isOwner: false,
    isSelf: false,
    ...extra,
  });

  it('lays patches over active entries by user id, leaves pending alone', () => {
    const derived: DerivedMembers = {
      agency: [entry('a', { emailOptIn: true, emailOptOutBy: null })],
      client: [entry('c', { role: 'client', emailOptIn: true })],
      pending: [entry('c')],
    };
    const out = withEmailPatches(
      derived,
      new Map([['c', { emailOptIn: false, emailOptOutBy: 'a' }]]),
    );
    expect(out.agency[0]).toBe(derived.agency[0]);
    expect(out.client[0]).toMatchObject({ emailOptIn: false, emailOptOutBy: 'a' });
    expect(out.pending).toBe(derived.pending);
    expect(withEmailPatches(derived, new Map())).toBe(derived);
  });

  it('lists only off-by managers who are not on the held list, once each', () => {
    const derived: DerivedMembers = {
      agency: [entry('a'), entry('b', { emailOptIn: false, emailOptOutBy: 'a' })],
      client: [
        entry('c', { emailOptIn: false, emailOptOutBy: 'gone' }),
        entry('d', { emailOptIn: false, emailOptOutBy: 'gone' }),
        entry('e', { emailOptIn: false, emailOptOutBy: null }),
      ],
      pending: [],
    };
    expect(missingOffByIds(derived)).toEqual(['gone']);
  });
});
