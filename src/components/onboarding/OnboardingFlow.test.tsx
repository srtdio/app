// @vitest-environment jsdom
import { act, forwardRef, useImperativeHandle, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequest, mockSave, mockUsername, newTrace, rows, mockSignout, mockNavigate, calls } =
  vi.hoisted(() => ({
    // Stable, as useNewTrace's is in the app.
    newTrace: () => 'trace',
    mockRequest: vi.fn(),
    mockSave: vi.fn(),
    mockUsername: vi.fn(),
    mockSignout: vi.fn(async () => undefined),
    mockNavigate: vi.fn(),
    calls: [] as string[],
    /** What each table read answers, per test. */
    rows: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  }));

/** A chainable read: .select().eq()...maybeSingle() answers rows[table]. */
function tableRead(table: string): unknown {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => rows[table] ?? { data: null, error: null },
  };
  return chain;
}

// Every client the flow touches is stubbed, so nothing builds a real Supabase client.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: null } }) },
    from: (table: string) => tableRead(table),
  },
}));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({
    session: { user: { id: 'u-1', email: 'riya@kite.in', user_metadata: {} } },
  }),
  performSignout: async () => {
    calls.push('signout');
    await mockSignout();
  },
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => (to: string, opts?: unknown) => {
    calls.push(`navigate ${to}`);
    mockNavigate(to, opts);
  },
}));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => newTrace }));
vi.mock('@srtdio/rpc', () => ({ userOnboardingSave: mockSave, usernameAvailable: mockUsername }));
vi.mock('@/components/induction/induction-data', () => ({
  requestBrandTeam: mockRequest,
  readLatestBrandRequest: async () => undefined,
}));
// The cropper draws on a canvas: a stand-in keeps the file it is handed.
vi.mock('@/components/onboarding/AvatarCropper', () => ({
  AvatarCropper: forwardRef<
    {
      hasPhoto: () => boolean;
      exportPng: () => Promise<File | null>;
      loadFile: (file: File) => void;
    },
    { onPhotoChange?: (info: { hasPhoto: boolean; previewUrl: string | null }) => void }
  >(function FakeCropper({ onPhotoChange }, ref) {
    const loadedRef = useRef<File | null>(null);
    useImperativeHandle(ref, () => ({
      hasPhoto: () => loadedRef.current !== null,
      exportPng: async () => loadedRef.current,
      loadFile: (file: File) => {
        loadedRef.current = file;
        onPhotoChange?.({ hasPhoto: true, previewUrl: 'blob:photo' });
      },
    }));
    return <div>Cropper</div>;
  }),
}));
// A native select stands in for the custom dropdown.
vi.mock('@/components/ui/Select', () => ({
  Select: (props: {
    label?: string;
    value: string;
    options: readonly { value: string; label: string }[];
    onChange: (v: string) => void;
  }) => (
    <select
      aria-label={props.label}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    >
      <option value="">Pick</option>
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));

import { OnboardingFlow } from './OnboardingFlow';
import { WORKSPACE_STEP } from '@/lib/induction';
import type { CurrentProfile } from '@/lib/use-current-profile';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NEW_PROFILE: CurrentProfile = {
  display_name: 'riya',
  designation: null,
  avatar_url: null,
  email_opt_in: true,
  profile_completed_at: null,
  username: null,
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const onStep = vi.fn(async () => true);
const onFinish = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  URL.createObjectURL = () => 'blob:photo';
  mockRequest.mockReset();
  mockSave.mockReset();
  mockUsername.mockReset();
  mockUsername.mockResolvedValue({ ok: true, data: true });
  mockSave.mockResolvedValue({ ok: true, data: null });
  onStep.mockClear();
  onFinish.mockClear();
  mockSignout.mockClear();
  mockNavigate.mockClear();
  calls.length = 0;
  for (const key of Object.keys(rows)) delete rows[key];
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  vi.useRealTimers();
});

async function render(props: {
  profile?: CurrentProfile;
  workspaceId?: string | null;
  approverStage?: 'none' | 'brand' | 'waiting';
}): Promise<void> {
  root = createRoot(host!);
  await act(async () => {
    root!.render(
      <OnboardingFlow
        profile={props.profile ?? NEW_PROFILE}
        workspaceId={props.workspaceId ?? null}
        workspaceName={props.workspaceId != null ? 'Kite - Instagram' : null}
        approverStage={props.approverStage ?? 'none'}
        onStep={onStep}
        onFinish={onFinish}
        finishError={null}
      />,
    );
  });
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent === text);
  if (found === undefined) throw new Error(`no button ${text}`);
  return found;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => el.click());
}

async function type(el: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Pick a photo from the device, then keep it from the positioning sheet. */
async function addPhoto(): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Choose a photo"]')!;
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new File(['x'], 'IMG_4821.png', { type: 'image/png' })],
  });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  await click(button('Use this photo'));
}

async function pick(label: string, value: string): Promise<void> {
  // The stand-in select is a plain element here; set its value as a browser would.
  const el = document.querySelector<HTMLElement>(`select[aria-label="${label}"]`);
  if (el === null) throw new Error(`no select ${label}`);
  await act(async () => {
    Object.assign(el, { value });
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** Side (Creator or Approver), then a name with a free username. */
async function toNameScreen(side: 'Creator' | 'Approver'): Promise<void> {
  await render({});
  await click(button(`${side}${side === 'Creator' ? 'We make the posts' : 'We approve them'}`));
  await click(button('Continue'));
  await type(document.querySelector<HTMLInputElement>('#ob-name')!, 'Riya Menon');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  // The availability answer resolves on the next turn.
  await act(async () => {
    await Promise.resolve();
  });
}

function stepLabel(): string {
  return document.querySelector('[role="progressbar"]')?.getAttribute('aria-label') ?? '';
}

/** An invitee whose membership, workspace and inviter read as given. */
function invitedAs(opts: { role: string; inviter?: string | null; inviterFails?: boolean }): void {
  rows.workspace_members = {
    data: { id: 'inv-42', role: opts.role, invited_by: opts.inviter === null ? null : 'u-9' },
    error: null,
  };
  rows.workspaces = { data: { name: 'Kite', platform: 'instagram' }, error: null };
  rows.users = opts.inviterFails
    ? { data: null, error: { message: 'denied' } }
    : { data: { display_name: opts.inviter ?? 'Meera Shah' }, error: null };
}

async function renderInvitee(): Promise<void> {
  await render({ workspaceId: 'ws-1' });
  // The membership, then the inviter, resolve over a few turns.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe('invited welcome', () => {
  it('opens an invitee on the welcome, never on the side question or a password', async () => {
    invitedAs({ role: 'agency' });
    await renderInvitee();
    expect(document.querySelector('h1')?.textContent).toBe('Welcome to Kite');
    expect(document.body.textContent).not.toContain('Who are you here as?');
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it('shows the platform with the platform mark and label', async () => {
    invitedAs({ role: 'agency' });
    await renderInvitee();
    expect(document.querySelector('[aria-label="instagram"]')?.textContent).toBe('ig');
    expect(document.body.textContent).toContain('Instagram');
  });

  it('greets a creator (agency or admin) with the inviter name', async () => {
    invitedAs({ role: 'admin' });
    await renderInvitee();
    expect(document.body.textContent).toContain(
      'Meera Shah invited you to create posts with the team.',
    );
  });

  it('greets an approver (client) with the review line', async () => {
    invitedAs({ role: 'client' });
    await renderInvitee();
    expect(document.body.textContent).toContain(
      'Meera Shah invited you to review posts for the team.',
    );
  });

  it('falls back to The team when the inviter cannot be read', async () => {
    invitedAs({ role: 'agency', inviterFails: true });
    await renderInvitee();
    expect(document.body.textContent).toContain(
      'The team invited you to create posts with the team.',
    );
  });

  it('falls back to The team when there is no inviter', async () => {
    invitedAs({ role: 'client', inviter: null });
    await renderInvitee();
    expect(document.body.textContent).toContain(
      'The team invited you to review posts for the team.',
    );
  });

  it('shows Joining as with the signed-in email as text, no email input', async () => {
    invitedAs({ role: 'agency' });
    await renderInvitee();
    expect(document.body.textContent).toContain('Joining as riya@kite.in');
    expect(document.querySelector('input[type="email"]')).toBeNull();
  });

  it('Not you signs out, then goes to sign in on the way back to the invite', async () => {
    invitedAs({ role: 'agency' });
    await renderInvitee();
    await click(button('Not you? Sign in with a different email'));
    expect(calls).toEqual(['signout', 'navigate /signin?next=/invite/accept/inv-42']);
  });

  it('Not you falls back to the pipeline when the invite id is unknown', async () => {
    await renderInvitee();
    await click(button('Not you? Sign in with a different email'));
    expect(mockNavigate).toHaveBeenCalledWith('/signin?next=/pipeline', { replace: true });
  });

  it('shows no step count on the welcome, then Step 1 of 2 and Step 2 of 2', async () => {
    invitedAs({ role: 'client' });
    await renderInvitee();
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
    expect(document.body.textContent).not.toContain('Step ');
    await click(button('Continue'));
    expect(stepLabel()).toBe('Step 1 of 2');
    expect(document.body.textContent).toContain('What should we call you?');
    await type(document.querySelector<HTMLInputElement>('#ob-name')!, 'Riya Menon');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await act(async () => {
      await Promise.resolve();
    });
    await addPhoto();
    await click(button('Continue'));
    expect(stepLabel()).toBe('Step 2 of 2');
    // An approver invitee picks from the approver roles: the side came from the membership.
    await pick('Your role', 'Brand manager');
    await click(button('Continue'));
    const payload = mockSave.mock.calls[0]?.[1]?.p_payload as Record<string, unknown>;
    expect(payload.designation).toBe('Brand manager');
    expect('age_range' in payload).toBe(false);
    expect(onFinish).toHaveBeenCalledWith('/pipeline');
  });
});

describe('pre-app screens', () => {
  it('opens a self sign-up on Who are you here as?, Creator and Approver', async () => {
    await render({});
    expect(document.body.textContent).toContain('Who are you here as?');
    expect(document.body.textContent).toContain('We make the posts');
    expect(document.body.textContent).toContain('We approve them');
    expect(button('Continue').disabled).toBe(true);
  });

  it('counts the self sign-up steps: side, name, role', async () => {
    await render({});
    expect(stepLabel()).toBe('Step 1 of 3');
  });

  it('requires a photo before the name screen continues', async () => {
    await toNameScreen('Creator');
    expect(mockUsername.mock.calls.length).toBe(1);
    expect(document.body.textContent).toContain('@riya.menon is yours.');
    expect(button('Continue').disabled).toBe(true);
    await addPhoto();
    expect(button('Continue').disabled).toBe(false);
  });

  it('takes free text for Something else, with no age range and no How did you hear', async () => {
    await toNameScreen('Creator');
    await addPhoto();
    await click(button('Continue'));
    expect(stepLabel()).toBe('Step 3 of 3');
    expect(document.body.textContent).not.toContain('How did you hear');
    expect(document.body.textContent).not.toContain('age range');
    expect(document.querySelector('[aria-label="Your age range"]')).toBeNull();
    await pick('Your role', 'Something else');
    expect(button('Continue').disabled).toBe(true);
    await type(document.querySelector<HTMLInputElement>('#ob-role-other')!, 'Community lead');
    expect(button('Continue').disabled).toBe(false);
    await click(button('Continue'));
    const payload = mockSave.mock.calls[0]?.[1]?.p_payload as Record<string, unknown>;
    expect(payload.designation).toBe('Community lead');
    expect('age_range' in payload).toBe(false);
    expect('heard_from' in payload).toBe(false);
    // A Creator goes into the shell to make the workspace.
    expect(onStep).toHaveBeenCalledWith(WORKSPACE_STEP);
    expect(onFinish).toHaveBeenCalledWith('/pipeline');
  });

  it('sends an approver who signed up alone on to name their team', async () => {
    await toNameScreen('Approver');
    await addPhoto();
    await click(button('Continue'));
    await pick('Your role', 'Brand manager');
    await click(button('Continue'));
    expect(onStep).toHaveBeenCalledWith('approver_brand');
    expect(document.body.textContent).toContain('Who makes your posts?');
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('records the request with brand_agency_request, then waits', async () => {
    mockRequest.mockResolvedValue({ ok: true, data: 'req-1' });
    await render({
      profile: { ...NEW_PROFILE, profile_completed_at: '2026-10-15T00:00:00Z' },
      approverStage: 'brand',
    });
    await type(document.querySelector<HTMLInputElement>('#ob-team-email')!, 'dev@studio.in');
    await type(document.querySelector<HTMLInputElement>('#ob-brand')!, 'Kite');
    await click(button('Ask them to join'));
    expect(mockRequest).toHaveBeenCalledWith(expect.anything(), {
      email: 'dev@studio.in',
      brandName: 'Kite',
      traceId: 'trace',
    });
    expect(onStep).toHaveBeenCalledWith('approver_waiting');
    expect(document.body.textContent).toContain('Your team is on its way');
    expect(document.body.textContent).not.toContain('I make the posts after all');
  });

  it('maps too_many_requests on Resend to the five-sends line', async () => {
    mockRequest.mockResolvedValue({
      ok: false,
      error: { code: 'unknown', message: 'too_many_requests' },
    });
    await render({
      profile: { ...NEW_PROFILE, profile_completed_at: '2026-10-15T00:00:00Z' },
      approverStage: 'brand',
    });
    await type(document.querySelector<HTMLInputElement>('#ob-team-email')!, 'dev@studio.in');
    await type(document.querySelector<HTMLInputElement>('#ob-brand')!, 'Kite');
    await click(button('Ask them to join'));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'You have sent this 5 times. Ask them to check spam, or write to us.',
    );
  });

  it('holds a waiting approver on the wait, with Resend and no way round it', async () => {
    await render({
      profile: { ...NEW_PROFILE, profile_completed_at: '2026-10-15T00:00:00Z' },
      approverStage: 'waiting',
    });
    expect(document.body.textContent).toContain('Your team is on its way');
    expect(button('Resend')).toBeDefined();
    expect(document.body.textContent).not.toContain('after all');
    expect(onFinish).not.toHaveBeenCalled();
  });
});
