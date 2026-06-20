import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// The accept screen renders outside the workspace shell; stub the supabase
// client so importing the page never spins up a real client and so we can
// assert no invoke is fired during the render phase (effects do not run under
// renderToStaticMarkup, which keeps these tests node-env and fast).
const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: mockInvoke } } }));

import { AcceptInvitePage, acceptInvite, ACCEPT_ERROR_MESSAGE } from './AcceptInvitePage';

// Mirror the App routes so the path param (/invite/accept/:inviteId) and the
// legacy query form (/invite/accept?invite=) both resolve as they do in prod.
function render(path: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/invite/accept" element={<AcceptInvitePage />} />
        <Route path="/invite/accept/:inviteId" element={<AcceptInvitePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AcceptInvitePage render states', () => {
  it('shows the invalid state and never calls invoke when no id is present', () => {
    mockInvoke.mockReset();
    const out = render('/invite/accept');
    expect(out).toContain('This invite link is invalid.');
    expect(out).toContain('/signin');
    expect(out).not.toContain('Joining your workspace');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('treats an empty query id as invalid without calling invoke', () => {
    mockInvoke.mockReset();
    const out = render('/invite/accept?invite=');
    expect(out).toContain('This invite link is invalid.');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('renders the joining state for a path id and never the error on mount', () => {
    mockInvoke.mockReset();
    const out = render('/invite/accept/inv-123');
    expect(out).toContain('Join a workspace on Sorted');
    expect(out).toContain('Joining your workspace');
    expect(out).not.toContain('This invite link is invalid.');
    expect(out).not.toContain(ACCEPT_ERROR_MESSAGE);
  });

  it('renders the joining state for a legacy query id', () => {
    mockInvoke.mockReset();
    const out = render('/invite/accept?invite=inv-123');
    expect(out).toContain('Joining your workspace');
  });

  it('lets the path id take precedence over the query id', () => {
    mockInvoke.mockReset();
    // A whitespace path segment wins over a valid query id, so the trimmed id is
    // empty and the invalid state shows. Query precedence would render joining.
    const out = render('/invite/accept/%20?invite=inv-123');
    expect(out).toContain('This invite link is invalid.');
    expect(out).not.toContain('Joining your workspace');
  });
});

describe('acceptInvite', () => {
  it('invokes invite-accept once with { invite_id } + trace header and signals success', async () => {
    const invoke = vi.fn().mockResolvedValue({ error: null });
    const onSuccess = vi.fn();
    const onError = vi.fn();

    await acceptInvite({ inviteId: 'inv-123', traceId: 't-1', invoke, onSuccess, onError });

    expect(invoke).toHaveBeenCalledTimes(1);
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
