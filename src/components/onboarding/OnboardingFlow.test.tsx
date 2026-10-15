// @vitest-environment jsdom
import { act, forwardRef, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequest, mockSave, mockUsername, newTrace } = vi.hoisted(() => ({
  // Stable, as useNewTrace's is in the app.
  newTrace: () => 'trace',
  mockRequest: vi.fn(),
  mockSave: vi.fn(),
  mockUsername: vi.fn(),
}));

// Every client the flow touches is stubbed, so nothing builds a real Supabase client.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: null } }), updateUser: vi.fn() },
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
      }),
    }),
  },
}));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({
    session: { user: { id: 'u-1', email: 'riya@kite.in', user_metadata: {} } },
  }),
}));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => newTrace }));
vi.mock('@srtdio/rpc', () => ({ userOnboardingSave: mockSave, usernameAvailable: mockUsername }));
vi.mock('@/components/induction/induction-data', () => ({
  requestBrandTeam: mockRequest,
  readLatestBrandRequest: async () => undefined,
}));
// The cropper draws on a canvas; a stand-in button "picks" a photo.
vi.mock('@/components/onboarding/AvatarCropper', () => ({
  AvatarCropper: forwardRef<
    { hasPhoto: () => boolean; exportPng: () => Promise<File | null> },
    { onPhotoChange?: (info: { hasPhoto: boolean; previewUrl: string | null }) => void }
  >(function FakeCropper({ onPhotoChange }, ref) {
    useImperativeHandle(ref, () => ({
      hasPhoto: () => true,
      exportPng: async () => new File(['x'], 'me.png', { type: 'image/png' }),
    }));
    return (
      <button
        type="button"
        onClick={() => onPhotoChange?.({ hasPhoto: true, previewUrl: 'blob:me' })}
      >
        Pick photo
      </button>
    );
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
  mockRequest.mockReset();
  mockSave.mockReset();
  mockUsername.mockReset();
  mockUsername.mockResolvedValue({ ok: true, data: true });
  mockSave.mockResolvedValue({ ok: true, data: null });
  onStep.mockClear();
  onFinish.mockClear();
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

describe('pre-app screens', () => {
  it('opens a self sign-up on Who are you here as?, Creator and Approver', async () => {
    await render({});
    expect(document.body.textContent).toContain('Who are you here as?');
    expect(document.body.textContent).toContain('We make the posts');
    expect(document.body.textContent).toContain('We approve them');
    expect(button('Continue').disabled).toBe(true);
  });

  it('opens an invitee on the password, never on the side question', async () => {
    await render({ workspaceId: 'ws-1' });
    expect(document.body.textContent).toContain('Join Kite - Instagram');
    expect(document.body.textContent).not.toContain('Who are you here as?');
  });

  it('requires a photo before the name screen continues', async () => {
    await toNameScreen('Creator');
    expect(mockUsername.mock.calls.length).toBe(1);
    expect(document.body.textContent).toContain('@riya.menon is yours.');
    expect(button('Continue').disabled).toBe(true);
    await click(button('Pick photo'));
    expect(button('Continue').disabled).toBe(false);
  });

  it('takes free text for Something else, needs an age, and has no How did you hear', async () => {
    await toNameScreen('Creator');
    await click(button('Pick photo'));
    await click(button('Continue'));
    expect(document.body.textContent).not.toContain('How did you hear');
    await pick('Your role', 'Something else');
    await type(document.querySelector<HTMLInputElement>('#ob-role-other')!, 'Community lead');
    expect(button('Continue').disabled).toBe(true);
    await click(button('25-34'));
    await click(button('Continue'));
    const payload = mockSave.mock.calls[0]?.[1]?.p_payload as Record<string, unknown>;
    expect(payload.designation).toBe('Community lead');
    expect(payload.age_range).toBe('25-34');
    expect('heard_from' in payload).toBe(false);
    // A Creator goes into the shell to make the workspace.
    expect(onStep).toHaveBeenCalledWith('workspace');
    expect(onFinish).toHaveBeenCalledWith('/pipeline');
  });

  it('sends an approver who signed up alone on to name their team', async () => {
    await toNameScreen('Approver');
    await click(button('Pick photo'));
    await click(button('Continue'));
    await pick('Your role', 'Brand manager');
    await click(button('18-24'));
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
    expect(document.body.textContent).toContain('I make the posts after all');
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

  it('switches a waiting approver to the Creator path', async () => {
    await render({
      profile: { ...NEW_PROFILE, profile_completed_at: '2026-10-15T00:00:00Z' },
      approverStage: 'waiting',
    });
    await click(button('I make the posts after all'));
    expect(onStep).toHaveBeenCalledWith('workspace');
    expect(onFinish).toHaveBeenCalledWith('/pipeline');
  });
});
