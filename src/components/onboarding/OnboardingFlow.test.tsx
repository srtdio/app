// @vitest-environment jsdom
import { act, forwardRef, useImperativeHandle, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRequest,
  mockSave,
  mockUsername,
  newTrace,
  rows,
  mockSignout,
  mockNavigate,
  calls,
  testEnv,
  mockUploadAvatar,
} = vi.hoisted(() => ({
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
  /** The env the flow reads; a test sets VITE_AVATAR_UPLOAD_URL to send the photo. */
  testEnv: {} as Record<string, unknown>,
  mockUploadAvatar: vi.fn(),
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
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: Object.assign(testEnv, actual.env) };
});
vi.mock('@/lib/avatar-upload', () => ({ uploadAvatarFile: mockUploadAvatar }));
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
import { ONBOARDING_COPY } from '@/lib/induction-copy';
import { SIGNOUT_EVENT } from '@/lib/events';
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
  delete testEnv.VITE_AVATAR_UPLOAD_URL;
  mockUploadAvatar.mockReset();
  window.localStorage.clear();
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
  return document.querySelector('[data-onboarding-step]')?.textContent?.trim() ?? '';
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
    expect(document.body.textContent).not.toContain('Your role');
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

  it('shows no step count on the welcome, then Setup 1 of 2 and Setup 2 of 2', async () => {
    invitedAs({ role: 'client' });
    await renderInvitee();
    expect(document.querySelector('[data-onboarding-step]')).toBeNull();
    expect(document.body.textContent).not.toContain('Step ');
    await click(button('Continue'));
    expect(stepLabel()).toBe('Setup 1 of 2');
    expect(document.body.textContent).toContain('Your name');
    await type(document.querySelector<HTMLInputElement>('#ob-name')!, 'Riya Menon');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await act(async () => {
      await Promise.resolve();
    });
    await addPhoto();
    await click(button('Continue'));
    expect(stepLabel()).toBe('Setup 2 of 2');
    // An approver invitee picks from the approver roles: the side came from the membership.
    await pick('Job title', 'Brand manager');
    await click(button('Continue'));
    const payload = mockSave.mock.calls[0]?.[1]?.p_payload as Record<string, unknown>;
    expect(payload.designation).toBe('Brand manager');
    expect('age_range' in payload).toBe(false);
    expect(onFinish).toHaveBeenCalledWith('/pipeline');
  });
});

describe('pre-app screens', () => {
  it("opens a self sign-up on How you'll use Sorted, Creator and Approver", async () => {
    await render({});
    expect(document.querySelector('h1')?.textContent).toBe("How you'll use Sorted");
    expect(document.body.textContent).not.toContain('Your role');
    expect(document.body.textContent).toContain('We make the posts');
    expect(document.body.textContent).toContain('We approve them');
    expect(button('Continue').disabled).toBe(true);
  });

  it('counts the self sign-up steps: side, name, role', async () => {
    await render({});
    expect(stepLabel()).toBe('Setup 1 of 3');
  });

  // W11 fix 8: the pre-app counter never reads like the guide's "Step 1".
  it('says Setup, never Step, so it cannot clash with the guide', async () => {
    await render({});
    expect(document.body.textContent).toContain('Setup 1 of 3');
    expect(document.body.textContent).not.toMatch(/Step \d/);
  });

  // W11 fix 1: the photo is optional.
  it('continues from the name screen without a photo', async () => {
    await toNameScreen('Creator');
    expect(mockUsername.mock.calls.length).toBe(1);
    expect(document.body.textContent).toContain('@riya.menon is yours.');
    expect(button('Add a photo (optional)')).toBeDefined();
    expect(document.body.textContent).not.toContain('Needed to continue');
    expect(button('Continue').disabled).toBe(false);
    await click(button('Continue'));
    await click(button('Continue'));
    const payload = mockSave.mock.calls[0]?.[1]?.p_payload as Record<string, unknown>;
    expect('avatar_url' in payload).toBe(false);
    expect(onFinish).toHaveBeenCalledWith('/pipeline');
  });

  // W11 fix 1: a failed upload never blocks the save.
  it('saves the profile when the photo fails to upload, and says so', async () => {
    testEnv.VITE_AVATAR_UPLOAD_URL = 'https://avatar.test/upload';
    mockUploadAvatar.mockResolvedValue({ ok: false, error: { message: 'network' } });
    await toNameScreen('Approver');
    await addPhoto();
    await click(button('Continue'));
    await click(button('Continue'));
    expect(mockSave).toHaveBeenCalledTimes(1);
    const payload = mockSave.mock.calls[0]?.[1]?.p_payload as Record<string, unknown>;
    expect('avatar_url' in payload).toBe(false);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).toContain(
      "Couldn't upload your photo. You can add it later in settings.",
    );
    expect(document.body.textContent).toContain('Who makes your posts?');
  });

  // W11 fix 4: the job title is optional.
  it('saves without a job title, labelled optional', async () => {
    await toNameScreen('Creator');
    await click(button('Continue'));
    expect(document.body.textContent).toContain('Job title (optional)');
    expect(button('Continue').disabled).toBe(false);
    await click(button('Continue'));
    const payload = mockSave.mock.calls[0]?.[1]?.p_payload as Record<string, unknown>;
    expect(payload.designation).toBe('');
    expect(payload.username).toBe('riya.menon');
  });

  // W11 fix 7: hints are 12px or larger.
  it('draws no 11px hint on the name screen', async () => {
    await toNameScreen('Creator');
    expect(document.querySelector('[class*="text-xs"]')).toBeNull();
  });

  it('takes free text for Something else, with no age range and no How did you hear', async () => {
    await toNameScreen('Creator');
    await addPhoto();
    await click(button('Continue'));
    expect(stepLabel()).toBe('Setup 3 of 3');
    expect(document.body.textContent).not.toContain('How did you hear');
    expect(document.body.textContent).not.toContain('age range');
    expect(document.querySelector('[aria-label="Your age range"]')).toBeNull();
    await pick('Job title', 'Something else');
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
    await pick('Job title', 'Brand manager');
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
    expect(button('I make the posts after all')).toBeDefined();
  });

  // W11 fix 2: a wrong side is changed from the next screen, through the induction step.
  it('lets an approver change to Creator from the brand screen', async () => {
    await toNameScreen('Approver');
    await click(button('Continue'));
    await click(button('Continue'));
    expect(document.body.textContent).toContain('Who makes your posts?');
    expect(document.querySelector('button[aria-label="Back"]')).not.toBeNull();
    await click(button(ONBOARDING_COPY.changeRole));
    expect(document.querySelector('h1')?.textContent).toBe("How you'll use Sorted");
    await click(button('CreatorWe make the posts'));
    await click(button('Continue'));
    expect(onStep).toHaveBeenLastCalledWith(WORKSPACE_STEP);
    expect(onFinish).toHaveBeenCalledWith('/pipeline');
    // The profile is not saved again: only the side moved.
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it('Back from the brand screen opens the side, and Back again returns', async () => {
    await render({
      profile: { ...NEW_PROFILE, profile_completed_at: '2026-10-15T00:00:00Z' },
      approverStage: 'brand',
    });
    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!);
    expect(document.querySelector('h1')?.textContent).toBe("How you'll use Sorted");
    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!);
    expect(document.body.textContent).toContain('Who makes your posts?');
    expect(onStep).not.toHaveBeenCalled();
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

  // W11 fix 3: the solo approver can leave the wait.
  it('offers Resend, I make the posts after all, Use a different email and Sign out', async () => {
    await render({
      profile: { ...NEW_PROFILE, profile_completed_at: '2026-10-15T00:00:00Z' },
      approverStage: 'waiting',
    });
    expect(document.body.textContent).toContain('Your team is on its way');
    expect(button('Resend')).toBeDefined();
    for (const label of ['I make the posts after all', 'Use a different email', 'Sign out']) {
      expect(button(label).className).toContain('min-h-[44px]');
    }
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('I make the posts after all sends the approver on as a Creator', async () => {
    await render({
      profile: { ...NEW_PROFILE, profile_completed_at: '2026-10-15T00:00:00Z' },
      approverStage: 'waiting',
    });
    await click(button('I make the posts after all'));
    expect(onStep).toHaveBeenCalledWith(WORKSPACE_STEP);
    expect(onFinish).toHaveBeenCalledWith('/pipeline');
  });

  it('Use a different email signs out, then opens sign-up', async () => {
    await render({
      profile: { ...NEW_PROFILE, profile_completed_at: '2026-10-15T00:00:00Z' },
      approverStage: 'waiting',
    });
    await click(button('Use a different email'));
    expect(calls).toEqual(['signout', 'navigate /signup']);
  });

  it('Sign out raises the app sign-out event', async () => {
    await render({
      profile: { ...NEW_PROFILE, profile_completed_at: '2026-10-15T00:00:00Z' },
      approverStage: 'waiting',
    });
    const heard = vi.fn();
    window.addEventListener(SIGNOUT_EVENT, heard);
    await click(button('Sign out'));
    window.removeEventListener(SIGNOUT_EVENT, heard);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('refresh mid-onboarding', () => {
  const DRAFT_KEY = 'srtd.onboarding.draft.u-1';

  function storedDraft(): Record<string, unknown> | null {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
  }

  it('keeps the answers on the device as the person goes', async () => {
    await toNameScreen('Creator');
    expect(storedDraft()).toMatchObject({ step: 'name', side: 'creator', name: 'Riya Menon' });
  });

  it('opens on the screen it stopped at, with the answers and photo back', async () => {
    window.localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        step: 'role',
        side: 'creator',
        name: 'Riya Menon',
        username: 'rm',
        usernameEdited: true,
        role: 'Copywriter',
        roleOther: '',
        avatarUrl: 'https://cdn.test/riya.png',
        teamEmail: '',
        brandName: '',
      }),
    );
    await render({});
    expect(stepLabel()).toBe('Setup 3 of 3');
    const title = document.querySelector('select[aria-label="Job title"]') as unknown as {
      value: string;
    };
    expect(title.value).toBe('Copywriter');
    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!);
    expect(document.querySelector<HTMLInputElement>('#ob-name')?.value).toBe('Riya Menon');
    expect(document.querySelector<HTMLInputElement>('#ob-username')?.value).toBe('rm');
    expect(document.body.textContent).toContain('Change photo');
  });

  it('saves the photo uploaded before the refresh, then forgets the draft', async () => {
    window.localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        step: 'role',
        side: 'creator',
        name: 'Riya Menon',
        username: 'rm',
        usernameEdited: true,
        role: 'Copywriter',
        roleOther: '',
        avatarUrl: 'https://cdn.test/riya.png',
        teamEmail: '',
        brandName: '',
      }),
    );
    await render({});
    await click(button('Continue'));
    const payload = mockSave.mock.calls[0]?.[1]?.p_payload as Record<string, unknown>;
    expect(payload.avatar_url).toBe('https://cdn.test/riya.png');
    expect(payload.username).toBe('rm');
    expect(storedDraft()).toBeNull();
  });

  it('ignores a draft that is not one', async () => {
    window.localStorage.setItem(DRAFT_KEY, '{not json');
    await render({});
    expect(stepLabel()).toBe('Setup 1 of 3');
  });
});

describe('username check', () => {
  it('a check that gets no answer does not block Continue', async () => {
    mockUsername.mockResolvedValue({ ok: false, error: { message: 'permission denied' } });
    await toNameScreen('Creator');
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("We'll check @riya.menon when you continue.");
    await addPhoto();
    expect(button('Continue').disabled).toBe(false);
  });

  it('takes a two-letter username', async () => {
    await toNameScreen('Creator');
    await type(document.querySelector<HTMLInputElement>('#ob-username')!, 'rm');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain('@rm is yours.');
  });
});
