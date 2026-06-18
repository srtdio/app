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

import { MembersInviteForm, sendInvite, INVITE_ERROR_MESSAGE } from './MembersInviteForm';

describe('MembersInviteForm render', () => {
  it('shows email, role defaulting to client, and Send invite, with no status and no invoke', () => {
    mockInvoke.mockReset();
    const out = renderToStaticMarkup(<MembersInviteForm />);
    expect(out).toContain('Email');
    expect(out).toContain('type="email"');
    // The closed Select trigger shows the selected option's label.
    expect(out).toContain('Client (reviewer)');
    expect(out).toContain('Send invite');
    expect(out).not.toContain('Invitation sent to');
    expect(out).not.toContain(INVITE_ERROR_MESSAGE);
    expect(mockInvoke).not.toHaveBeenCalled();
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
});
