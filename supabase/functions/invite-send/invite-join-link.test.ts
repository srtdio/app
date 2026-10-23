import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { createClient } from '@supabase/supabase-js';
import { handleInviteSend, inviteEmailBody, inviteJoinUrl } from './handler.ts';

// W12: the email links to the app's Join page with ?th= (never the verify
// action_link), and delivery runs before the response so the answer is honest.

const WORKSPACE_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const BASE_ENV: Record<string, string> = {
  APP_BASE_URL: 'https://app.test',
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  SUPABASE_ANON_KEY: 'anon-key',
};

function query(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'limit']) chain[method] = () => chain;
  chain.maybeSingle = async () => result;
  return chain;
}

function harness(env: Record<string, string>) {
  const updates: unknown[] = [];
  const admin = {
    auth: {
      admin: {
        createUser: vi.fn(async () => ({ data: { user: { id: 'new-user' } }, error: null })),
        listUsers: vi.fn(async () => ({ data: { users: [] }, error: null })),
        generateLink: vi.fn(async () => ({
          data: {
            properties: {
              action_link: 'https://db.test/auth/v1/verify?token=SECRET_VERIFY&type=magiclink',
              hashed_token: 'hash-123',
            },
          },
          error: null,
        })),
      },
    },
    from: vi.fn((table: string) => {
      if (table === 'users') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { display_name: 'Priya Shah' }, error: null }),
            }),
          }),
        };
      }
      return {
        insert: () => ({
          select: () => ({ single: async () => ({ data: { id: 'attempt-1' }, error: null }) }),
        }),
        update: (row: unknown) => {
          updates.push(row);
          return { eq: async () => ({ error: null }) };
        },
      };
    }),
  };
  const caller = {
    auth: { getUser: async () => ({ data: { user: { id: 'inviter' } }, error: null }) },
    from: vi.fn((table: string) =>
      query({
        data: table === 'workspaces' ? { name: 'Acme', platform: 'instagram' } : { role: 'owner' },
        error: null,
      }),
    ),
    rpc: vi.fn(async (fn: string) =>
      fn === 'member_invite_check'
        ? { data: null, error: null }
        : { data: 'invite-1', error: null },
    ),
  };
  const factory = vi.fn((_url: string, key: string) => (key === 'service-key' ? admin : caller));
  return {
    admin,
    updates,
    deps: {
      env: (name: string) => env[name],
      createClient: factory as unknown as typeof createClient,
      // The mail-record lookup is stubbed so the global fetch mock sees only Resend.
      checkMailDomain: async () => 'ok' as const,
      isDisposableEmail: () => false,
    },
  };
}

function request(): Request {
  return new Request('https://fn.test/invite-send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer caller-jwt',
      'X-Trace-Id': 'trace-w12',
    },
    body: JSON.stringify({ workspace_id: WORKSPACE_ID, email: 'person@brand.com', role: 'agency' }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('W12 invite email link (B29)', () => {
  it('the email button links to the Join page with th= and never the verify action_link', async () => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ id: 'msg-1' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const h = harness({ ...BASE_ENV, RESEND_API_KEY: 'rk', INVITE_FROM_ADDRESS: 'f@sorted.test' });

    const res = await handleInviteSend(request(), h.deps);
    expect(res.status).toBe(200);
    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      html: string;
      text: string;
    };
    expect(sent.html).toContain('https://app.test/invite/accept/invite-1?th=hash-123');
    expect(sent.text).toContain('https://app.test/invite/accept/invite-1?th=hash-123');
    expect(sent.html).not.toContain('SECRET_VERIFY');
    expect(sent.text).not.toContain('SECRET_VERIFY');
    expect(sent.html).not.toContain('/auth/v1/verify');
    expect(sent.text).toContain('Tap Join on the page that opens.');
  });

  it('builds the Join url with the workspace and inviter names', () => {
    const url = new URL(
      inviteJoinUrl({
        appBaseUrl: 'https://app.test/',
        inviteId: 'inv-1',
        hashedToken: 'h1',
        workspace: 'Acme - Instagram',
        inviter: 'Priya',
      }),
    );
    expect(url.pathname).toBe('/invite/accept/inv-1');
    expect(url.searchParams.get('th')).toBe('h1');
    expect(url.searchParams.get('ws')).toBe('Acme - Instagram');
    expect(url.searchParams.get('by')).toBe('Priya');
  });

  it('the email copy has no em-dash and no auto sign-in promise', () => {
    const e = inviteEmailBody({
      brand: 'Acme',
      displayName: 'Acme',
      role: 'agency',
      acceptUrl: 'https://a.test',
    });
    expect(e.text).not.toContain('\u2014');
    expect(e.html).not.toContain('\u2014');
    expect(e.text).not.toContain('signs you in');
  });
});

describe('W12 honest sent status (NEW9)', () => {
  it('answers emailed:false with resend_not_configured, never queued', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness(BASE_ENV);
    const res = await handleInviteSend(request(), h.deps);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.emailed).toBe(false);
    expect(body.error_detail).toBe('resend_not_configured');
    expect(body.accept_url).toBe('https://app.test/invite/accept/invite-1');
  });

  it('answers emailed:false with the send failure after Resend refuses', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    const h = harness({ ...BASE_ENV, RESEND_API_KEY: 'rk', INVITE_FROM_ADDRESS: 'f@sorted.test' });
    const res = await handleInviteSend(request(), h.deps);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.emailed).toBe(false);
    expect(body.error_detail).not.toBe('queued');
    expect(h.updates).toContainEqual(expect.objectContaining({ status: 'failed' }));
  });

  it('index.ts no longer defers delivery with EdgeRuntime.waitUntil', () => {
    const src = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
    const code = src
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toContain('waitUntil');
    expect(code).not.toContain('EdgeRuntime');
  });
});
