import { describe, expect, it, vi } from 'vitest';
import type { AgoraChat } from 'agora-chat';
import { runChatConnection, type RunChatConnectionParams } from '@/lib/chat/controller';
import type { ChatConnection, ChatStatus, ChatTokenResult } from '@/lib/chat/types';

const token: Extract<ChatTokenResult, { ok: true }> = {
  ok: true,
  token: 'agora-token',
  expires_at: '2026-06-14T10:00:00.000Z',
  agora_username: 'u_abc',
  app_key: 'org#app',
};

/** Drain pending microtasks (the fetchToken -> open chain) on a macrotask turn. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface FakeConnection extends ChatConnection {
  handler: () => AgoraChat.EventHandlerType | null;
}

function fakeConnection(): FakeConnection {
  let captured: AgoraChat.EventHandlerType | null = null;
  return {
    open: vi.fn().mockResolvedValue({ accessToken: 'ok' }),
    close: vi.fn(),
    renewToken: vi.fn().mockResolvedValue({ status: true }),
    addEventHandler: vi.fn((_id: string, h: AgoraChat.EventHandlerType) => {
      captured = h;
    }),
    removeEventHandler: vi.fn(),
    handler: () => captured,
  };
}

interface Harness {
  params: RunChatConnectionParams;
  conn: FakeConnection;
  createConnection: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  setClient: ReturnType<typeof vi.fn>;
  removeSignout: ReturnType<typeof vi.fn>;
  signout: () => void;
}

function harness(fetchToken: () => Promise<ChatTokenResult>): Harness {
  const conn = fakeConnection();
  const createConnection = vi.fn(() => conn);
  const setStatus = vi.fn<(status: ChatStatus) => void>();
  const setClient = vi.fn<(client: ChatConnection | null) => void>();
  const removeSignout = vi.fn();
  let signoutHandler: () => void = () => {};
  const addSignoutListener = (handler: () => void): (() => void) => {
    signoutHandler = handler;
    return removeSignout;
  };
  return {
    params: { fetchToken, createConnection, setStatus, setClient, addSignoutListener },
    conn,
    createConnection,
    setStatus,
    setClient,
    removeSignout,
    signout: () => signoutHandler(),
  };
}

describe('runChatConnection availability gate', () => {
  it('reports unavailable and never builds a connection when the token fetch fails (e.g. URL unset)', async () => {
    const h = harness(() => Promise.resolve({ ok: false }));

    runChatConnection(h.params);
    await flush();

    expect(h.setStatus).toHaveBeenNthCalledWith(1, 'connecting');
    expect(h.setStatus).toHaveBeenLastCalledWith('unavailable');
    expect(h.createConnection).not.toHaveBeenCalled();
    expect(h.setClient).not.toHaveBeenCalled();
  });

  it('opens with the worker username + token and reports connected', async () => {
    const h = harness(() => Promise.resolve(token));

    runChatConnection(h.params);
    await flush();

    expect(h.createConnection).toHaveBeenCalledWith('org#app');
    expect(h.conn.open).toHaveBeenCalledWith({ user: 'u_abc', accessToken: 'agora-token' });
    expect(h.setStatus).toHaveBeenLastCalledWith('connected');
    expect(h.setClient).toHaveBeenCalledWith(h.conn);
  });

  it('resolves to unavailable (never throws) when the SDK open rejects', async () => {
    const h = harness(() => Promise.resolve(token));
    h.conn.open = vi.fn().mockRejectedValue(new Error('sdk down'));

    runChatConnection(h.params);
    await flush();

    expect(h.conn.close).toHaveBeenCalledOnce();
    expect(h.conn.removeEventHandler).toHaveBeenCalledOnce();
    expect(h.setStatus).toHaveBeenLastCalledWith('unavailable');
    expect(h.setClient).not.toHaveBeenCalledWith(h.conn);
  });
});

describe('runChatConnection teardown', () => {
  it('closes the connection and removes the signout listener on signout', async () => {
    const h = harness(() => Promise.resolve(token));

    runChatConnection(h.params);
    await flush();
    h.signout();

    expect(h.conn.removeEventHandler).toHaveBeenCalledOnce();
    expect(h.conn.close).toHaveBeenCalledOnce();
    expect(h.removeSignout).toHaveBeenCalledOnce();
    expect(h.setClient).toHaveBeenLastCalledWith(null);
    expect(h.setStatus).toHaveBeenLastCalledWith('unavailable');
  });

  it('closes the prior connection when torn down (as on a workspace change)', async () => {
    const h = harness(() => Promise.resolve(token));

    const teardown = runChatConnection(h.params);
    await flush();
    teardown();

    expect(h.conn.removeEventHandler).toHaveBeenCalledOnce();
    expect(h.conn.close).toHaveBeenCalledOnce();
    expect(h.removeSignout).toHaveBeenCalledOnce();
    expect(h.setClient).toHaveBeenLastCalledWith(null);
  });
});

describe('runChatConnection renewal', () => {
  it('renews via onTokenWillExpire by fetching a fresh token and calling renewToken', async () => {
    const fetchToken = vi
      .fn<() => Promise<ChatTokenResult>>()
      .mockResolvedValueOnce(token)
      .mockResolvedValueOnce({ ...token, token: 'renewed-token' });
    const h = harness(fetchToken);

    runChatConnection(h.params);
    await flush();

    const handler = h.conn.handler();
    handler?.onTokenWillExpire?.();
    await flush();

    expect(fetchToken).toHaveBeenCalledTimes(2);
    expect(h.conn.renewToken).toHaveBeenCalledWith('renewed-token');
  });
});
