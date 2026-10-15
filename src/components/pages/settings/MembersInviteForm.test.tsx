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
vi.mock('@/components/ui/Textarea', () => ({ Textarea: 'textarea' }));

import {
  MembersInviteForm,
  sendInvite,
  INVITE_ERROR_MESSAGE,
  INVITE_INVALID_EMAIL_MESSAGE,
  isValidInviteEmail,
  getInviteRoleOptions,
  parseInviteEmails,
} from './MembersInviteForm';
import { FREE_MAIL_APPROVER_MESSAGE } from './members-data';

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

  it('keeps all existing role options for owners and admins', () => {
    expect(getInviteRoleOptions(false).map(({ value }) => value)).toEqual([
      'admin',
      'agency',
      'client',
    ]);
  });
});

describe('MembersInviteForm render', () => {
  it('keeps individual invites and adds group invites below without invoking on render', () => {
    mockInvoke.mockReset();
    const out = renderToStaticMarkup(<MembersInviteForm />);
    expect(out).toContain('Invite member');
    expect(out).toContain('>Approver<');
    expect(out).not.toContain('Client (reviewer)');
    expect(out).toContain('type="email"');
    expect(out).toContain('Send invite');
    expect(out).toContain('Invite group members');
    expect(out).toContain('Add people');
    expect(out).toContain('<textarea');
    expect(out).toContain('Add email');
    expect(out).toContain('Send 0 invitations');
    expect(out).not.toContain(INVITE_ERROR_MESSAGE);
    expect(mockInvoke).not.toHaveBeenCalled();

    const individualInviteIndex = out.indexOf('Invite member');
    const groupInviteIndex = out.indexOf('Invite group members');
    expect(individualInviteIndex).toBeLessThan(groupInviteIndex);
    expect(out.indexOf('>Approver<')).toBeLessThan(groupInviteIndex);
  });

  it('restricts client invite forms to the client role', () => {
    const out = renderToStaticMarkup(<MembersInviteForm clientOnly />);
    expect(out).toContain('Invite group members');
    expect(out.match(/>Approver</g)).toHaveLength(1);
    expect(out).not.toContain('Agency (team member)');
    expect(out).not.toContain('>Admin<');
  });
});

describe('sendInvite', () => {
  it('invokes invite-send once with the exact body + trace header and signals success', async () => {
    const invoke = vi.fn().mockResolvedValue({ error: null });
    const onSuccess = vi.fn();
    const onError = vi.fn();

    await sendInvite({
      workspaceId: 'ws-1',
      email: 'name@example.com',
      role: 'client',
      traceId: 't-1',
      invoke,
      onSuccess,
      onError,
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('invite-send', {
      body: { workspace_id: 'ws-1', email: 'name@example.com', role: 'client' },
      headers: { 'x-trace-id': 't-1' },
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('signals an error and does not succeed when invoke returns an error', async () => {
    const invoke = vi.fn().mockResolvedValue({ error: new Error('forbidden') });
    const onSuccess = vi.fn();
    const onError = vi.fn();

    await sendInvite({
      workspaceId: 'ws-1',
      email: 'name@example.com',
      role: 'admin',
      traceId: 't-1',
      invoke,
      onSuccess,
      onError,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('does not invoke invite-send for an invalid domain', async () => {
    const invoke = vi.fn();
    const onSuccess = vi.fn();
    const onError = vi.fn();

    await sendInvite({
      workspaceId: 'ws-1',
      email: 'name@example',
      role: 'client',
      traceId: 't-1',
      invoke,
      onSuccess,
      onError,
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(INVITE_INVALID_EMAIL_MESSAGE, null);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('reports transport failures instead of leaving the invite pending', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('network failure'));
    const onSuccess = vi.fn();
    const onError = vi.fn();

    await expect(
      sendInvite({
        workspaceId: 'ws-1',
        email: 'name@example.com',
        role: 'client',
        traceId: 't-1',
        invoke,
        onSuccess,
        onError,
      }),
    ).resolves.toEqual({ ok: false, message: INVITE_ERROR_MESSAGE, code: null });
    expect(onError).toHaveBeenCalledWith(null, null);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe('sendInvite error mapping', () => {
  function failingInvoke(body: Record<string, unknown>) {
    return vi.fn().mockResolvedValue({
      error: { context: { json: async () => body } },
    });
  }

  async function send(body: Record<string, unknown>) {
    const onError = vi.fn();
    const result = await sendInvite({
      workspaceId: 'ws-1',
      email: 'name@gmail.com',
      role: 'client',
      traceId: 't-1',
      invoke: failingInvoke(body),
      onSuccess: vi.fn(),
      onError,
    });
    return { result, onError };
  }

  it('words free_mail_client as the work-address line', async () => {
    const { result, onError } = await send({
      error: 'free_mail_client',
      error_detail: 'free_mail_client',
      trace_id: 't-1',
    });
    expect(result).toEqual({
      ok: false,
      message: FREE_MAIL_APPROVER_MESSAGE,
      code: 'free_mail_client',
    });
    expect(FREE_MAIL_APPROVER_MESSAGE).toBe(
      'Your approver needs a work address, like name@theirbrand.com.',
    );
    expect(onError).toHaveBeenCalledWith(FREE_MAIL_APPROVER_MESSAGE, 'free_mail_client');
  });

  it('flags client_domain_mismatch so the panel shows the toast', async () => {
    const { result, onError } = await send({
      error: 'client_domain_mismatch',
      error_detail: 'client_domain_mismatch',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('client_domain_mismatch');
    expect(onError.mock.calls[0]![1]).toBe('client_domain_mismatch');
  });

  it('keeps the detail line for other failures', async () => {
    const { result } = await send({ error: 'forbidden_role', error_detail: 'forbidden_role' });
    expect(result).toEqual({
      ok: false,
      message: 'Invite failed: forbidden_role',
      code: null,
    });
  });
});
