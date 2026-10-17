import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// The accept screen renders outside the workspace shell; stub the supabase
// client so importing the page never spins up a real client and so we can
// assert no invoke is fired during the render phase (effects do not run under
// renderToStaticMarkup, which keeps these tests node-env and fast).
const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: mockInvoke } } }));

import { RECOVERY_COPY } from '@/lib/induction-copy';
import {
  AcceptFailureView,
  AcceptInvitePage,
  acceptInvite,
  ACCEPT_ERROR_MESSAGE,
  classifyAcceptError,
  INVITE_DESTINATION,
  inviteSignInPath,
  invokeErrorStatus,
  switchAccount,
  type AcceptFailure,
} from './AcceptInvitePage';

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

// A FunctionsHttpError-shaped error: supabase-js puts the fetch Response on context.
function httpError(status: number): Error & { context: { status: number } } {
  return Object.assign(new Error('Edge Function returned a non-2xx status code'), {
    context: { status },
  });
}

describe('accept error classification', () => {
  it('reads the status off the invoke error context', () => {
    expect(invokeErrorStatus(httpError(403))).toBe(403);
    expect(invokeErrorStatus(new Error('network'))).toBe(0);
    expect(invokeErrorStatus({ context: { status: '403' } })).toBe(0);
    expect(invokeErrorStatus(null)).toBe(0);
    expect(invokeErrorStatus('x')).toBe(0);
  });

  it.each([
    [403, 'wrong-account'],
    [404, 'not-found'],
    [500, 'generic'],
    [401, 'generic'],
  ])('status %i is %s', (status, kind) => {
    expect(classifyAcceptError(httpError(status))).toBe(kind);
  });

  it.each([
    [403, 'wrong-account'],
    [404, 'not-found'],
    [500, 'generic'],
  ])('acceptInvite hands the %i failure kind to onError', async (status, kind) => {
    const invoke = vi.fn().mockResolvedValue({ error: httpError(status) });
    const onError = vi.fn();
    await acceptInvite({ inviteId: 'i', traceId: 't', invoke, onSuccess: vi.fn(), onError });
    expect(onError).toHaveBeenCalledWith(kind);
  });
});

describe('invite destination', () => {
  it('lands on the pipeline, which opens on Review', () => {
    expect(INVITE_DESTINATION).toBe('/pipeline');
  });

  it('builds the sign-in path back to this invitation', () => {
    expect(inviteSignInPath('inv-1')).toBe('/signin?next=%2Finvite%2Faccept%2Finv-1');
  });
});

describe('switchAccount', () => {
  it('signs out first, then goes to sign in with the invitation as next', async () => {
    const order: string[] = [];
    const signOut = vi.fn(async () => {
      order.push('signOut');
      return { error: null };
    });
    const navigate = vi.fn((path: string) => order.push(`navigate ${path}`));
    await switchAccount({ inviteId: 'inv-1', signOut, navigate });
    expect(order).toEqual(['signOut', 'navigate /signin?next=%2Finvite%2Faccept%2Finv-1']);
  });

  it('still goes to sign in when sign-out fails or throws', async () => {
    const navigate = vi.fn();
    await switchAccount({
      inviteId: 'inv-1',
      signOut: async () => ({ error: new Error('x') }),
      navigate,
    });
    await switchAccount({
      inviteId: 'inv-1',
      signOut: async () => Promise.reject(new Error('down')),
      navigate,
    });
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenLastCalledWith('/signin?next=%2Finvite%2Faccept%2Finv-1');
  });
});

describe('AcceptFailureView', () => {
  // renderToStaticMarkup escapes the apostrophe.
  const errorHtml = ACCEPT_ERROR_MESSAGE.replace("'", '&#x27;');
  const actions = { retry: vi.fn(), goToWorkspace: vi.fn(), switchAccount: vi.fn() };
  const view = (failure: AcceptFailure): string =>
    renderToStaticMarkup(
      <AcceptFailureView failure={failure} submitting={false} actions={actions} />,
    );

  it('wrong account explains and offers a different email, with no retry', () => {
    const html = view('wrong-account');
    expect(html).toContain(RECOVERY_COPY.wrongAccount);
    expect(html).toContain(RECOVERY_COPY.differentEmail);
    expect(html).not.toContain('Try again');
    expect(html).not.toContain(errorHtml);
    expect(html).toContain('h-11');
  });

  it.each(['not-found', 'generic'] as const)('%s keeps the plain message and retry', (kind) => {
    const html = view(kind);
    expect(html).toContain(errorHtml);
    expect(html).toContain('Try again');
    expect(html).toContain('Go to your workspace');
    expect(html).not.toContain(RECOVERY_COPY.wrongAccount);
  });
});
