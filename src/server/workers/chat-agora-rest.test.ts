import { describe, expect, it, vi } from 'vitest';

import {
  AgoraRestError,
  createAgoraGroupApi,
  createAgoraMessageApi,
  type AgoraTextMessage,
  type TracedFetchFn,
} from './chat-agora-rest';

vi.mock('agora-token', () => ({
  ChatTokenBuilder: { buildAppToken: vi.fn(() => 'app-token') },
}));

const CONFIG = { appId: 'app', appCertificate: 'cert', restUrl: 'https://a.example/org/app/' };

const MESSAGE: AgoraTextMessage = {
  from: 'u_sender',
  to: 'u_peer',
  chatType: 'singleChat',
  msg: 'hello',
  ext: { sorted_message_id: 'm1' },
};

function fetchReturning(response: Response): ReturnType<typeof vi.fn<TracedFetchFn>> {
  return vi.fn<TracedFetchFn>(() => Promise.resolve(response));
}

describe('createAgoraMessageApi.sendMessage', () => {
  it('posts a DM to /messages/users as the sender, with the trace id', async () => {
    const fetchImpl = fetchReturning(new Response('{}', { status: 200 }));
    await createAgoraMessageApi(CONFIG, fetchImpl).sendMessage(MESSAGE, 'trace-1');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init, traceId] = fetchImpl.mock.calls[0] as Parameters<TracedFetchFn>;
    expect(url).toBe('https://a.example/org/app/messages/users');
    expect(traceId).toBe('trace-1');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ authorization: 'Bearer app-token' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual({
      from: 'u_sender',
      to: ['u_peer'],
      type: 'txt',
      body: { msg: 'hello' },
      ext: { sorted_message_id: 'm1' },
      sync_device: true,
    });
  });

  it('posts a group message to /messages/chatgroups', async () => {
    const fetchImpl = fetchReturning(new Response('{}', { status: 200 }));
    await createAgoraMessageApi(CONFIG, fetchImpl).sendMessage(
      { ...MESSAGE, to: '170000000000000001', chatType: 'groupChat' },
      'trace-2',
    );
    const [url, init] = fetchImpl.mock.calls[0] as Parameters<TracedFetchFn>;
    expect(url).toBe('https://a.example/org/app/messages/chatgroups');
    expect(JSON.parse(init.body as string)).toMatchObject({ to: ['170000000000000001'] });
  });

  it('throws an AgoraRestError carrying operation, status and body on non-2xx', async () => {
    const fetchImpl = fetchReturning(new Response('forbidden', { status: 403 }));
    const error = await createAgoraMessageApi(CONFIG, fetchImpl)
      .sendMessage(MESSAGE, 'trace-3')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgoraRestError);
    expect(error).toMatchObject({ operation: 'send_message', status: 403, body: 'forbidden' });
  });
});

describe('createAgoraGroupApi.createGroup', () => {
  it('creates a private, owner-invite-only group capped at 200 members', async () => {
    const fetchImpl = fetchReturning(
      new Response(JSON.stringify({ data: { groupid: 'g1' } }), { status: 200 }),
    );
    const groupId = await createAgoraGroupApi(CONFIG, fetchImpl).createGroup(
      { name: 'Acme', ownerUsername: 'u_owner', memberUsernames: ['u_owner', 'u_a'] },
      'trace-4',
    );

    expect(groupId).toBe('g1');
    const [url, init] = fetchImpl.mock.calls[0] as Parameters<TracedFetchFn>;
    expect(url).toBe('https://a.example/org/app/chatgroups');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.public).toBe(false);
    expect(body.allowinvites).toBe(false);
    expect(body).not.toHaveProperty('membersonly');
    expect(body.maxusers).toBe(200);
    expect(body.members).toEqual(['u_a']);
  });
});
