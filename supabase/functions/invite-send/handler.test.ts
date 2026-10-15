import { describe, expect, it, vi } from 'vitest';
import type { createClient } from '@supabase/supabase-js';
import {
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

describe('invite email copy', () => {
  const URL_ = 'https://app.test/accept?x=1&y=2';
  const email = (role: string, platform: string | null = 'instagram') => {
    const displayName = workspaceDisplayName('Acme', platform);
    return {
      subject: inviteSubject(displayName),
      ...inviteEmailBody({ brand: 'Acme', displayName, role, acceptUrl: URL_ }),
    };
  };

  it('subject, heading and footer use "<Brand> - <Platform>"', () => {
    const e = email('client');
    expect(e.subject).toBe("You're invited to Acme - Instagram on Sorted");
    expect(e.html).toContain('Join Acme - Instagram on Sorted</h1>');
    expect(e.html).toContain('for the Acme - Instagram workspace.');
    expect(e.text.startsWith('Join Acme - Instagram on Sorted\n')).toBe(true);
    expect(e.text).toContain('Sent by Sorted for the Acme - Instagram workspace.');
    expect(workspaceDisplayName('Acme', 'youtube_shorts')).toBe('Acme - YouTube Shorts');
  });

  it('client reads as an Approver', () => {
    const e = email('client');
    const line =
      "You've been added as an Approver. Posts made for Acme come to you here for review: comment, ask for changes, or approve.";
    expect(e.text).toContain(line);
    expect(e.html).toContain(
      'You&#39;ve been added as an Approver.</strong> Posts made for Acme come to you here for review: comment, ask for changes, or approve.',
    );
  });

  it('agency reads as a Creator', () => {
    expect(email('agency').text).toContain(
      "You've been added as a Creator. You'll make posts for Acme here and send them to its approvers for review.",
    );
  });

  it('admin reads as a Creator who can manage members', () => {
    expect(email('admin').text).toContain(
      "You've been added as a Creator who can manage members. You'll make posts for Acme here and send them to its approvers for review.",
    );
  });

  it.each(['client', 'agency', 'admin'])(
    '%s email never says client, agency, trial or an em-dash',
    (role) => {
      const e = email(role);
      for (const part of [e.subject, e.html, e.text]) {
        expect(part).not.toMatch(/client|agency|trial|\u2014/i);
        expect(part).toContain('Acme');
      }
      expect(e.html).toContain('>Accept invitation</a>');
      expect(e.html).toContain('href="https://app.test/accept?x=1&amp;y=2"');
    },
  );

  it.each([null, undefined, 'myspace'])(
    'unknown platform (%s) falls back to the name',
    (platform) => {
      const displayName = workspaceDisplayName('Acme', platform);
      expect(displayName).toBe('Acme');
      expect(inviteSubject(displayName)).toBe("You're invited to Acme on Sorted");
    },
  );

  it('escapes interpolated brand names', () => {
    const displayName = workspaceDisplayName('<b>&Co', 'x');
    const e = inviteEmailBody({ brand: '<b>&Co', displayName, role: 'agency', acceptUrl: URL_ });
    expect(e.html).toContain('Join &lt;b&gt;&amp;Co - X on Sorted');
    expect(e.html).not.toContain('<b>&Co');
  });
});
