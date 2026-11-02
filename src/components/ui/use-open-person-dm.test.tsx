// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DomainError } from '@srtdio/rpc';
import { useOpenPersonDm, type OpenPersonDmOptions } from '@/components/ui/use-open-person-dm';
import { notesChannelId } from '@/lib/chat/notes';
import { MENTION_DM_FAILED } from '@/lib/person-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WS = '0190a000-0000-7000-8000-00000000a001';
const ME = '0190a000-0000-7000-8000-000000000001';
const PEER = '0190a000-0000-7000-8000-000000000002';
const LEO = '0190a000-0000-7000-8000-000000000003';
const DM = `dm__${WS}__${ME}__${PEER}`;
const NEW_DM = `dm__${WS}__${ME}__${LEO}`;

/** Everything the hook did, in order (beforeOpen, navigate, start, toast). */
const spy = vi.hoisted(() => ({
  events: [] as string[],
  workspaceId: '0190a000-0000-7000-8000-00000000a001' as string | null,
  roster: [] as Array<{ channelId: string; channelType: string; peerUserId: string | null }>,
  startParams: [] as Array<{ workspaceId: string; peerUserId: string; traceId: string }>,
  startResult: {
    channelId: null as string | null,
    failure: null as { code: string; message: string } | null,
  },
  toasts: [] as Array<{ title: string }>,
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => (to: string) => {
    spy.events.push(`navigate:${to}`);
  },
}));

vi.mock('@/components/chat/ChatStoreProvider', () => ({
  useChatStore: () => ({ roster: spy.roster }),
}));

vi.mock('@/components/chat/chat-actions', () => ({
  startDmChannel: async (
    _client: unknown,
    params: { workspaceId: string; peerUserId: string; traceId: string },
    onOpen: (channelId: string) => void,
  ) => {
    spy.events.push('start');
    spy.startParams.push(params);
    if (spy.startResult.failure !== null) return spy.startResult.failure;
    if (spy.startResult.channelId !== null) onOpen(spy.startResult.channelId);
    return null;
  },
}));

vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({
    show: (options: { title: string }) => {
      spy.events.push('toast');
      spy.toasts.push(options);
      return 'toast-1';
    },
    dismiss: () => {},
  }),
}));

vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: '0190a000-0000-7000-8000-000000000001' } } }),
}));

vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: spy.workspaceId }),
}));

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

vi.mock('@/lib/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

type OpenDm = (userId: string, options?: OpenPersonDmOptions) => void;

let root: Root | null = null;
let openDm: OpenDm | null = null;

function Probe(): null {
  openDm = useOpenPersonDm();
  return null;
}

async function mount(): Promise<OpenDm> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<Probe />);
  });
  if (openDm === null) throw new Error('hook not mounted');
  return openDm;
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const chatHref = (channelId: string) => `/chat?channel=${encodeURIComponent(channelId)}`;

const beforeOpen = (channelId: string): void => {
  spy.events.push(`before:${channelId}`);
};

beforeEach(() => {
  spy.events = [];
  spy.workspaceId = WS;
  spy.roster = [{ channelId: DM, channelType: 'dm', peerUserId: PEER }];
  spy.startParams = [];
  spy.startResult = { channelId: NEW_DM, failure: null };
  spy.toasts = [];
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  openDm = null;
  document.body.innerHTML = '';
});

describe('useOpenPersonDm', () => {
  it('a cached DM navigates at once without startDmChannel', async () => {
    const open = await mount();
    act(() => open(PEER, { beforeOpen }));
    await flush();
    expect(spy.events).toEqual([`before:${DM}`, `navigate:${chatHref(DM)}`]);
    expect(spy.startParams).toEqual([]);
  });

  it('me opens my notes without an rpc', async () => {
    const open = await mount();
    act(() => open(ME));
    await flush();
    expect(spy.events).toEqual([`navigate:${chatHref(notesChannelId(WS, ME))}`]);
  });

  it('an uncached person calls startDmChannel, then navigates to the DM it returns', async () => {
    const open = await mount();
    act(() => open(LEO, { beforeOpen }));
    await flush();
    expect(spy.startParams).toHaveLength(1);
    expect(spy.startParams[0]).toMatchObject({ workspaceId: WS, peerUserId: LEO });
    expect(typeof spy.startParams[0]?.traceId).toBe('string');
    expect(spy.startParams[0]?.traceId).not.toBe('');
    // beforeOpen runs with the channel id right before the navigate.
    expect(spy.events).toEqual(['start', `before:${NEW_DM}`, `navigate:${chatHref(NEW_DM)}`]);
    expect(spy.toasts).toEqual([]);
  });

  it('a fresh trace per open', async () => {
    spy.roster = [];
    const open = await mount();
    act(() => open(LEO));
    act(() => open(LEO));
    await flush();
    expect(spy.startParams).toHaveLength(2);
    expect(spy.startParams[0]?.traceId).not.toBe(spy.startParams[1]?.traceId);
  });

  it('a failure toasts MENTION_DM_FAILED and does not navigate', async () => {
    const failure: DomainError = { code: 'unknown', message: 'boom' };
    spy.startResult = { channelId: null, failure };
    const open = await mount();
    act(() => open(LEO, { beforeOpen }));
    await flush();
    expect(spy.toasts).toEqual([{ title: MENTION_DM_FAILED }]);
    expect(spy.events).toEqual(['start', 'toast']);
  });

  it('no workspace: does nothing', async () => {
    spy.workspaceId = null;
    const open = await mount();
    act(() => open(LEO, { beforeOpen }));
    await flush();
    expect(spy.events).toEqual([]);
  });
});
