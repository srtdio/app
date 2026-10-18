import { describe, expect, it, vi } from 'vitest';
import type { createClient } from '@supabase/supabase-js';
import {
  firstName,
  handleInviteSend,
  inviteEmailBody,
  inviteSubject,
  workspaceDisplayName,
} from './handler.ts';

const WORKSPACE_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

const ENV: Record<string, string> = {
  APP_BASE_URL: 'https://app.test',
  SUPABASE_URL: 'https://db.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  SUPABASE_ANON_KEY: 'anon-key',
};

// A chainable PostgREST stub: every filter returns itself; maybeSingle resolves
// to the given result.
function query(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'limit']) chain[method] = () => chain;
  chain.maybeSingle = async () => result;
  return chain;
}

function setup(checkError: string | null) {
  const createUser = vi.fn(async () => ({ data: { user: { id: 'new-user' } }, error: null }));
  const listUsers = vi.fn(async () => ({ data: { users: [] }, error: null }));
  const callerRpc = vi.fn(async (fn: string) =>
    fn === 'member_invite_check'
      ? { data: null, error: checkError === null ? null : { message: checkError } }
      : { data: 'invite-1', error: null },
  );
  const admin = {
    auth: { admin: { createUser, listUsers, generateLink: vi.fn() } },
    from: vi.fn(),
  };
  const caller = {
    auth: { getUser: async () => ({ data: { user: { id: 'inviter' } }, error: null }) },
    from: vi.fn(() => query({ data: { role: 'owner' }, error: null })),
    rpc: callerRpc,
  };
  const factory = vi.fn((_url: string, key: string) => (key === 'service-key' ? admin : caller));
  return {
    deps: {
      env: (name: string) => ENV[name],
      createClient: factory as unknown as typeof createClient,
    },
    createUser,
    listUsers,
    callerRpc,
    admin,
  };
}

function request(body: unknown): Request {
  return new Request('https://fn.test/invite-send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer caller-jwt',
      'X-Trace-Id': 'trace-1',
    },
    body: JSON.stringify(body),
  });
}

describe('invite-send member_invite_check pre-flight', () => {
  it.each([
    ['free_mail_client', 400],
    ['client_domain_mismatch', 409],
    ['forbidden_role', 403],
  ])('a failing check (%s) creates no auth user and no invite', async (code, status) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = setup(code);
    const res = await handleInviteSend(
      request({ workspace_id: WORKSPACE_ID, email: 'Approver@Gmail.com', role: 'client' }),
      s.deps,
    );

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code, error_detail: code, trace_id: 'trace-1' });
    // The check ran as the caller with the normalised email, and nothing else did.
    expect(s.callerRpc).toHaveBeenCalledTimes(1);
    expect(s.callerRpc).toHaveBeenCalledWith('member_invite_check', {
      p_workspace_id: WORKSPACE_ID,
      p_email: 'approver@gmail.com',
      p_role: 'client',
    });
    expect(s.listUsers).not.toHaveBeenCalled();
    expect(s.createUser).not.toHaveBeenCalled();
    expect(s.admin.from).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('a passing check goes on to provision the user and run member_invite', async () => {
    const s = setup(null);
    s.admin.from.mockImplementation(() => {
      throw new Error('stop after member_invite');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await handleInviteSend(
      request({ workspace_id: WORKSPACE_ID, email: 'approver@brand.com', role: 'client' }),
      s.deps,
    );
    expect(s.callerRpc.mock.calls.map((c) => c[0])).toEqual([
      'member_invite_check',
      'member_invite',
    ]);
    expect(s.createUser).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});

describe('invite-send A1: unconfirmed existing accounts', () => {
  function existingAccount(confirmedAt: string | null) {
    const s = setup(null);
    s.createUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'A user with this email address has already been registered' },
    } as never);
    s.listUsers.mockResolvedValueOnce({
      data: {
        users: [
          { id: 'existing-user', email: 'approver@brand.com', email_confirmed_at: confirmedAt },
        ],
      },
      error: null,
    } as never);
    return s;
  }

  it('refuses an account whose email was never confirmed, before any invite row', async () => {
    const s = existingAccount(null);
    const res = await handleInviteSend(
      request({ workspace_id: WORKSPACE_ID, email: 'approver@brand.com', role: 'client' }),
      s.deps,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'unconfirmed_account',
      error_detail: 'unconfirmed_account',
      trace_id: 'trace-1',
    });
    expect(s.callerRpc.mock.calls.map((c) => c[0])).toEqual(['member_invite_check']);
    expect(s.admin.from).not.toHaveBeenCalled();
  });

  it('goes on to invite a confirmed existing account', async () => {
    const s = existingAccount('2026-10-01T00:00:00Z');
    s.admin.from.mockImplementation(() => {
      throw new Error('stop after member_invite');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await handleInviteSend(
      request({ workspace_id: WORKSPACE_ID, email: 'approver@brand.com', role: 'client' }),
      s.deps,
    );
    expect(s.callerRpc.mock.calls.map((c) => c[0])).toEqual([
      'member_invite_check',
      'member_invite',
    ]);
    errorSpy.mockRestore();
  });
});

describe('firstName', () => {
  it.each([
    ['Priya Shah', 'Priya'],
    ['  Priya   Shah  ', 'Priya'],
    ['Priya', 'Priya'],
    ['Priya\tShah', 'Priya'],
    ['', ''],
    ['   ', ''],
  ])('firstName(%j) is %j', (input, expected) => {
    expect(firstName(input)).toBe(expected);
  });
});

describe('invite subject', () => {
  it.each(['agency', 'admin'])('%s (creator) names the inviter and the brand', (role) => {
    expect(inviteSubject({ brand: 'Acme', role, inviterName: 'Priya Shah' })).toBe(
      'Priya invited you to Acme on Sorted',
    );
  });

  it('client (approver) names the inviter and review', () => {
    expect(inviteSubject({ brand: 'Acme', role: 'client', inviterName: 'Priya Shah' })).toBe(
      'Priya invited you to review posts on Sorted',
    );
  });

  it.each(['client', 'agency', 'admin'])('%s falls back when the inviter is unknown', (role) => {
    expect(inviteSubject({ brand: 'Acme', role, inviterName: '  ' })).toBe(
      "You're invited to Acme on Sorted",
    );
  });
});

describe('blank brand fallbacks', () => {
  it.each(['', '   '])('creator subject with brand %j drops the brand', (brand) => {
    for (const role of ['agency', 'admin']) {
      expect(inviteSubject({ brand, role, inviterName: 'Priya Shah' })).toBe(
        'Priya invited you to Sorted',
      );
    }
  });

  it.each(['', '   '])('no-inviter subject with brand %j drops the brand', (brand) => {
    for (const role of ['client', 'agency', 'admin']) {
      expect(inviteSubject({ brand, role, inviterName: '' })).toBe("You're invited to Sorted");
    }
  });

  it.each(['', '   '])('approver subject with brand %j is unchanged', (brand) => {
    expect(inviteSubject({ brand, role: 'client', inviterName: 'Priya' })).toBe(
      'Priya invited you to review posts on Sorted',
    );
  });

  it.each(['', '   '])('approver body with brand %j drops "for {brand}"', (brand) => {
    const e = inviteEmailBody({
      brand,
      displayName: brand,
      role: 'client',
      acceptUrl: 'https://a.test',
    });
    const line = 'Review posts and share your feedback with the team.';
    expect(e.text).toContain(`${line}\n\nReview posts:\nhttps://a.test`);
    expect(e.html).toContain(`>${line}</p>`);
    expect(e.text).not.toContain('Review posts for');
  });

  it('no subject or body ever carries a double space from a blank brand', () => {
    for (const role of ['client', 'agency', 'admin']) {
      for (const inviterName of ['Priya', '']) {
        expect(inviteSubject({ brand: ' ', role, inviterName })).not.toMatch(/ {2}/);
      }
      const e = inviteEmailBody({ brand: '', displayName: '', role, acceptUrl: 'https://a.test' });
      expect(e.text.split('\n')[2]).not.toMatch(/ {2}/);
    }
  });
});

describe('invite email copy', () => {
  const URL_ = 'https://app.test/accept?x=1&y=2';
  const NOTE =
    "This link signs you in and accepts the invite automatically. If you weren't expecting it, you can ignore this email.";
  const email = (role: string, platform: string | null = 'instagram') => {
    const displayName = workspaceDisplayName('Acme', platform);
    return {
      subject: inviteSubject({ brand: 'Acme', role, inviterName: 'Priya Shah' }),
      ...inviteEmailBody({ brand: 'Acme', displayName, role, acceptUrl: URL_ }),
    };
  };

  it('heading and footer use "<Brand> - <Platform>"', () => {
    const e = email('client');
    expect(e.html).toContain('Join Acme - Instagram on Sorted</h1>');
    expect(e.html).toContain('for the Acme - Instagram workspace.');
    expect(e.text.startsWith('Join Acme - Instagram on Sorted\n')).toBe(true);
    expect(e.text).toContain('Sent by Sorted for the Acme - Instagram workspace.');
    expect(workspaceDisplayName('Acme', 'youtube_shorts')).toBe('Acme - YouTube Shorts');
  });

  it('client (approver) body and button ask for a review', () => {
    const e = email('client');
    const line = 'Review posts for Acme and share your feedback with the team.';
    expect(e.text).toContain(`${line}\n\nReview posts:\n${URL_}`);
    expect(e.html).toContain(`>${line}</p>`);
    expect(e.html).toContain('>Review posts</a>');
  });

  it.each(['agency', 'admin'])('%s (creator) body and button join the workspace', (role) => {
    const e = email(role);
    const line = 'Join the workspace to create posts and work with the team.';
    expect(e.text).toContain(`${line}\n\nJoin workspace:\n${URL_}`);
    expect(e.html).toContain(`>${line}</p>`);
    expect(e.html).toContain('>Join workspace</a>');
  });

  it.each(['client', 'agency', 'admin'])(
    '%s keeps the sign-in note and footer verbatim',
    (role) => {
      const e = email(role);
      expect(e.text).toContain(NOTE);
      expect(e.html).toContain(`>${NOTE}</p>`);
      expect(e.text.endsWith('Sent by Sorted for the Acme - Instagram workspace.')).toBe(true);
    },
  );

  it.each(['client', 'agency', 'admin'])(
    '%s email never says client, agency, trial or an em-dash',
    (role) => {
      const e = email(role);
      for (const part of [e.subject, e.html, e.text]) {
        expect(part).not.toMatch(/client|agency|trial|\u2014/i);
      }
      expect(e.html).toContain('Acme');
      expect(e.text).toContain('Acme');
      expect(e.html).toContain('href="https://app.test/accept?x=1&amp;y=2"');
    },
  );

  it.each([null, undefined, 'myspace'])(
    'unknown platform (%s) falls back to the name',
    (platform) => {
      expect(workspaceDisplayName('Acme', platform)).toBe('Acme');
    },
  );

  it('escapes interpolated brand names', () => {
    const displayName = workspaceDisplayName('<b>&Co', 'x');
    const e = inviteEmailBody({ brand: '<b>&Co', displayName, role: 'client', acceptUrl: URL_ });
    expect(e.html).toContain('Join &lt;b&gt;&amp;Co - X on Sorted');
    expect(e.html).toContain('Review posts for &lt;b&gt;&amp;Co and share');
    expect(e.html).not.toContain('<b>&Co');
  });
});

describe('invite-send email delivery', () => {
  // A full happy path: the handler reads the inviter's display_name with the
  // service client and puts the first name in the Resend subject.
  function deliverySetup(inviter: { data: unknown; error: unknown }) {
    const s = setup(null);
    const update = { eq: vi.fn(async () => ({ error: null })) };
    const usersEq = vi.fn(() => ({ maybeSingle: async () => inviter }));
    s.admin.from.mockImplementation((table: string) => {
      if (table === 'users') return { select: () => ({ eq: usersEq }) };
      return {
        insert: () => ({
          select: () => ({ single: async () => ({ data: { id: 'a1' }, error: null }) }),
        }),
        update: () => update,
      };
    });
    s.admin.auth.admin.generateLink.mockResolvedValue({
      data: { properties: { action_link: 'https://db.test/verify?t=1' } },
      error: null,
    });
    const caller = s.deps.createClient('x', 'anon-key') as unknown as {
      from: ReturnType<typeof vi.fn>;
    };
    caller.from.mockImplementation((table: string) =>
      query({
        data: table === 'workspaces' ? { name: 'Acme', platform: 'instagram' } : { role: 'owner' },
        error: null,
      }),
    );
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ id: 'msg-1' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const env: Record<string, string> = {
      ...ENV,
      RESEND_API_KEY: 'rk',
      INVITE_FROM_ADDRESS: 'from@sorted.test',
    };
    const deps = { ...s.deps, env: (name: string) => env[name] };
    return { deps, fetchMock, usersEq };
  }

  async function sentSubject(inviter: { data: unknown; error: unknown }, role: string) {
    const d = deliverySetup(inviter);
    let res: Response;
    try {
      res = await handleInviteSend(
        request({ workspace_id: WORKSPACE_ID, email: 'person@brand.com', role }),
        d.deps,
      );
    } finally {
      vi.unstubAllGlobals();
    }
    expect(res.status).toBe(200);
    expect(d.usersEq).toHaveBeenCalledWith('id', 'inviter');
    const init = d.fetchMock.mock.calls[0]?.[1];
    return (JSON.parse(String(init?.body)) as { subject: string; text: string }).subject;
  }

  it('creator invite subject uses the inviter first name and the brand', async () => {
    const subject = await sentSubject(
      { data: { display_name: 'Priya Shah' }, error: null },
      'agency',
    );
    expect(subject).toBe('Priya invited you to Acme on Sorted');
  });

  it('approver invite subject uses the inviter first name', async () => {
    const subject = await sentSubject(
      { data: { display_name: 'Priya Shah' }, error: null },
      'client',
    );
    expect(subject).toBe('Priya invited you to review posts on Sorted');
  });

  it('falls back when the inviter row is missing', async () => {
    const subject = await sentSubject({ data: null, error: null }, 'client');
    expect(subject).toBe("You're invited to Acme on Sorted");
  });

  it('falls back when the inviter read fails', async () => {
    const subject = await sentSubject({ data: null, error: { message: 'boom' } }, 'agency');
    expect(subject).toBe("You're invited to Acme on Sorted");
  });
});
