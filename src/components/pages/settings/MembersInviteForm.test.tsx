import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Stub the supabase client so importing the form never spins up a real client
// and so we can assert invoke is NOT fired on render (sending is a submit).
const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: mockInvoke } } }));
// The form lives inside the shell; stub the two in-shell hooks so it renders
// without providers and a workspace id is always present.
vi.mock('@/lib/workspace-context', () => ({ useWorkspace: () => ({ workspaceId: 'ws-1' }) }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 't-1' }));

import {
  MembersInviteForm,
  sendInvite,
  INVITE_ERROR_MESSAGE,
  inviteErrorMessage,
  isValidInviteEmail,
  getInviteRoleOptions,
  parseInviteEmails,
  replacePendingInvite,
  suggestEmailFix,
} from './MembersInviteForm';
import type { SendInviteResult } from './MembersInviteForm';
import { UNCONFIRMED_ACCOUNT_MESSAGE } from './members-data';

describe('isValidInviteEmail', () => {
  it.each(['name@example.com', 'name@mail.example.co.uk', 'name@example.technology'])(
    'accepts %s',
    (email) => {
      expect(isValidInviteEmail(email)).toBe(true);
    },
  );

  it.each([
    'name@example',
    'name@example.c',
    'name@.com',
    'name@example..com',
    'name@example-.com',
    'name@exa_mple.com',
    'name@example.123',
  ])('rejects %s', (email) => {
    expect(isValidInviteEmail(email)).toBe(false);
  });
});

describe('parseInviteEmails', () => {
  it('splits common separators, trims, normalizes case, and removes duplicates', () => {
    expect(parseInviteEmails(' Alice@example.com,\nbob@example.com; alice@example.com ')).toEqual({
      emails: ['alice@example.com', 'bob@example.com'],
      invalid: [],
    });
  });

  it('splits on spaces, commas and new lines alike (a pasted list)', () => {
    expect(parseInviteEmails('a@brand.com b@brand.com\nc@brand.com,d@brand.com').emails).toEqual([
      'a@brand.com',
      'b@brand.com',
      'c@brand.com',
      'd@brand.com',
    ]);
  });

  it('returns invalid addresses without dropping valid addresses', () => {
    expect(parseInviteEmails('valid@example.com, not-an-email')).toEqual({
      emails: ['valid@example.com'],
      invalid: ['not-an-email'],
    });
  });
});

describe('invite role options', () => {
  it('limits client inviters to the approver role (no forbidden_role choices)', () => {
    expect(getInviteRoleOptions(true)).toEqual([{ value: 'client', label: 'Approver' }]);
  });

  it('keeps all existing role options for owners and admins, named by side', () => {
    expect(getInviteRoleOptions(false)).toEqual([
      { value: 'admin', label: 'Creator, can manage members' },
      { value: 'agency', label: 'Creator' },
      { value: 'client', label: 'Approver' },
    ]);
  });
});

describe('suggestEmailFix', () => {
  it('suggests the likely domain for a typo', () => {
    expect(suggestEmailFix('riya@gmial.com')).toBe('riya@gmail.com');
  });

  it('suggests nothing for a correct domain or a half-typed address', () => {
    expect(suggestEmailFix('riya@gmail.com')).toBeNull();
    expect(suggestEmailFix('riya')).toBeNull();
    expect(suggestEmailFix('riya@')).toBeNull();
  });
});

describe('MembersInviteForm render', () => {
  it('renders one entry box and the single-person button, without invoking on render', () => {
    mockInvoke.mockReset();
    const out = renderToStaticMarkup(<MembersInviteForm />);
    expect(out).toContain('Invite people');
    expect(out).toContain('Add one email or many. Press Enter, or paste a list.');
    expect(out).toContain('placeholder="name@company.com"');
    expect(out).toContain('type="email"');
    expect(out).toMatch(/inputmode="email"/i);
    expect(out).toMatch(/autocomplete="off"/i);
    expect(out).toMatch(/autocapitalize="none"/i);
    expect(out).toMatch(/spellcheck="false"/i);
    expect(out).toContain('id="invite-email"');
    expect(out).toContain('data-induction="members-invite"');
    expect(out).toContain('>Send invite<');
    // The old group form is gone.
    expect(out).not.toContain('<textarea');
    expect(out).not.toContain('Add email');
    expect(out).not.toContain('Invite group members');
    expect(out).not.toContain(INVITE_ERROR_MESSAGE);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe('sendInvite', () => {
  it('invokes invite-send once with the exact body + trace header and reads the outcome', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue({ data: { emailed: true, invite_id: 'm-9' }, error: null });

    const result = await sendInvite({
      workspaceId: 'ws-1',
      email: 'name@example.com',
      role: 'client',
      traceId: 't-1',
      invoke,
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('invite-send', {
      body: { workspace_id: 'ws-1', email: 'name@example.com', role: 'client' },
      headers: { 'x-trace-id': 't-1' },
    });
    expect(result).toEqual({
      ok: true,
      outcome: { emailed: true, errorDetail: null, acceptUrl: null, inviteId: 'm-9' },
    });
  });

  it('fails without a code when invoke returns an unreadable error', async () => {
    const invoke = vi.fn().mockResolvedValue({ error: new Error('forbidden') });
    await expect(
      sendInvite({
        workspaceId: 'ws-1',
        email: 'name@example.com',
        role: 'admin',
        traceId: 't-1',
        invoke,
      }),
    ).resolves.toEqual({ ok: false, code: null });
  });

  it('does not invoke invite-send for an invalid domain', async () => {
    const invoke = vi.fn();
    await sendInvite({
      workspaceId: 'ws-1',
      email: 'name@example',
      role: 'client',
      traceId: 't-1',
      invoke,
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reports transport failures instead of leaving the invite pending', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('network failure'));
    await expect(
      sendInvite({
        workspaceId: 'ws-1',
        email: 'name@example.com',
        role: 'client',
        traceId: 't-1',
        invoke,
      }),
    ).resolves.toEqual({ ok: false, code: null });
  });
});

describe('per-row error mapping', () => {
  async function codeFor(body: Record<string, unknown>) {
    const result = await sendInvite({
      workspaceId: 'ws-1',
      email: 'name@gmail.com',
      role: 'client',
      traceId: 't-1',
      invoke: vi.fn().mockResolvedValue({ error: { context: { json: async () => body } } }),
    });
    return result.ok ? 'sent' : result.code;
  }

  it('reads the three invite-check codes and words each one', async () => {
    expect(await codeFor({ error: 'client_domain_mismatch' })).toBe('client_domain_mismatch');
    expect(await codeFor({ error: 'disposable_email' })).toBe('disposable_email');
    expect(await codeFor({ error: 'email_domain_unreachable' })).toBe('email_domain_unreachable');

    expect(inviteErrorMessage('client_domain_mismatch', 'brand.com')).toBe(
      'Use a brand.com email, or a personal one like Gmail.',
    );
    expect(inviteErrorMessage('client_domain_mismatch', '')).toBe(INVITE_ERROR_MESSAGE);
    expect(inviteErrorMessage('disposable_email', 'brand.com')).toBe(
      "Temporary emails can't be invited. Use a permanent one.",
    );
    expect(inviteErrorMessage('email_domain_unreachable', 'brand.com')).toBe(
      "This email can't receive mail. Check the part after @.",
    );
  });

  it('words unconfirmed_account as the confirm-first line', async () => {
    expect(await codeFor({ error: 'unconfirmed_account' })).toBe('unconfirmed_account');
    expect(inviteErrorMessage('unconfirmed_account', '')).toBe(UNCONFIRMED_ACCOUNT_MESSAGE);
  });

  it('words other failures (free_mail_client is gone) as the plain line, never the code', async () => {
    expect(await codeFor({ error: 'forbidden_role' })).toBeNull();
    expect(await codeFor({ error: 'free_mail_client' })).toBeNull();
    expect(inviteErrorMessage(null, 'brand.com')).toBe(INVITE_ERROR_MESSAGE);
  });
});

describe('replacePendingInvite (Edit on a pending invite)', () => {
  const sent = (inviteId: string): SendInviteResult => ({
    ok: true,
    outcome: { emailed: true, errorDetail: null, acceptUrl: null, inviteId },
  });
  const refused: SendInviteResult = { ok: false, code: 'disposable_email' };

  function track(sendResults: SendInviteResult[], removeOk = true) {
    const calls: string[] = [];
    const send = vi.fn(async () => {
      calls.push('send');
      return sendResults.shift() ?? refused;
    });
    const remove = vi.fn(async () => {
      calls.push('remove');
      return removeOk;
    });
    return { calls, send, remove };
  }

  it('a new email sends first, then cancels the old invite', async () => {
    const t = track([sent('m-new')]);
    const result = await replacePendingInvite({ memberId: 'm-old', sameEmail: false, ...t });
    expect(t.calls).toEqual(['send', 'remove']);
    expect(result).toEqual({ ok: true, inviteId: 'm-new' });
  });

  it('a refused send keeps the old invite untouched', async () => {
    const t = track([refused]);
    const result = await replacePendingInvite({ memberId: 'm-old', sameEmail: false, ...t });
    expect(t.calls).toEqual(['send']);
    expect(result).toEqual({ ok: false, code: 'disposable_email', oldCancelled: false });
  });

  it('a role-only change cancels first, then sends', async () => {
    const t = track([sent('m-new')]);
    const result = await replacePendingInvite({ memberId: 'm-old', sameEmail: true, ...t });
    expect(t.calls).toEqual(['remove', 'send']);
    expect(result).toEqual({ ok: true, inviteId: 'm-new' });
  });

  it('falls back to cancel-then-send when invite-send hands back the old invite', async () => {
    const t = track([sent('m-old'), sent('m-new')]);
    const result = await replacePendingInvite({ memberId: 'm-old', sameEmail: false, ...t });
    expect(t.calls).toEqual(['send', 'remove', 'send']);
    expect(result).toEqual({ ok: true, inviteId: 'm-new' });
  });

  it('says the old invite was cancelled when the fallback send fails', async () => {
    const t = track([refused]);
    const result = await replacePendingInvite({ memberId: 'm-old', sameEmail: true, ...t });
    expect(t.calls).toEqual(['remove', 'send']);
    expect(result).toEqual({ ok: false, code: 'disposable_email', oldCancelled: true });
  });
});
