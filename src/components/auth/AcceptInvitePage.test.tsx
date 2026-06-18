import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

// The accept screen renders outside the workspace shell; stub the supabase
// client so importing the page never spins up a real client and so we can
// assert the invoke is NOT fired on render (accept is a deliberate click).
const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: mockInvoke } } }));

import { AcceptInvitePage, acceptInvite, ACCEPT_ERROR_MESSAGE } from './AcceptInvitePage';

function render(path: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <AcceptInvitePage />
    </MemoryRouter>,
  );
}

describe('AcceptInvitePage render states', () => {
  it('shows the invalid state and never calls invoke when the invite param is absent', () => {
    mockInvoke.mockReset();
    const out = render('/invite/accept');
    expect(out).toContain('This invite link is invalid.');
    expect(out).toContain('/signin');
    expect(out).not.toContain('Accept invitation');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('treats an empty invite param as invalid without calling invoke', () => {
    mockInvoke.mockReset();
    const out = render('/invite/accept?invite=');
    expect(out).toContain('This invite link is invalid.');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('renders the accept card for a present invite and does not auto-accept on mount', () => {
    mockInvoke.mockReset();
    const out = render('/invite/accept?invite=inv-123');
    expect(out).toContain('Join a workspace on Sorted');
    expect(out).toContain('Accept invitation');
    expect(out).not.toContain(ACCEPT_ERROR_MESSAGE);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe('acceptInvite', () => {
  it('invokes invite-accept with { invite_id } + trace header and signals success', async () => {
    const invoke = vi.fn().mockResolvedValue({ error: null });
    const onSuccess = vi.fn();
    const onError = vi.fn();

    await acceptInvite({ inviteId: 'inv-123', traceId: 't-1', invoke, onSuccess, onError });

    expect(invoke).toHaveBeenCalledWith('invite-accept', {
      body: { invite_id: 'inv-123' },
      headers: { 'x-trace-id': 't-1' },
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('signals an error and does not succeed when invoke returns an error', async () => {
    const invoke = vi.fn().mockResolvedValue({ error: new Error('used') });
    const onSuccess = vi.fn();
    const onError = vi.fn();

    await acceptInvite({ inviteId: 'inv-123', traceId: 't-1', invoke, onSuccess, onError });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
