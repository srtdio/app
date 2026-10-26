// @vitest-environment jsdom
// X8 regressions on the pre-app screens: the photo stays optional, the solo
// approver's waiting screen keeps its four ways out, and a Creator who switched
// to Approver from the make-a-workspace dialog opens on the brand screen.
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
vi.mock('@/lib/avatar-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/avatar-upload')>()),
  uploadAvatarFile: mockUploadAvatar,
  makeAvatarCleanup: () => () => Promise.resolve(),
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
import { APPROVER_BRAND_STEP } from '@/lib/induction';
import { ONBOARDING_COPY } from '@/lib/induction-copy';
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

const SAVED_PROFILE: CurrentProfile = {
  ...NEW_PROFILE,
  profile_completed_at: '2026-10-15T00:00:00Z',
};

describe('X8 photo stays optional', () => {
  it('a Creator continues from the name screen with no photo', async () => {
    await toNameScreen('Creator');
    expect(button(ONBOARDING_COPY.addPhoto)).toBeDefined();
    expect(button('Continue').disabled).toBe(false);
    await click(button('Continue'));
    expect(document.querySelector('#ob-name')).toBeNull();
  });

  it('an Approver continues from the name screen with no photo and saves without one', async () => {
    await toNameScreen('Approver');
    expect(button('Continue').disabled).toBe(false);
    await click(button('Continue'));
    await click(button('Continue'));
    const payload = mockSave.mock.calls[0]?.[1]?.p_payload as Record<string, unknown>;
    expect('avatar_url' in payload).toBe(false);
    expect(onStep).toHaveBeenCalledWith(APPROVER_BRAND_STEP);
  });
});

describe('X8 waiting screen keeps its four actions', () => {
  it('shows Resend, I make the posts after all, Use a different email and Sign out', async () => {
    await render({ profile: SAVED_PROFILE, approverStage: 'waiting' });
    expect(button('Resend')).toBeDefined();
    for (const label of [
      ONBOARDING_COPY.makePostsAfterAll,
      ONBOARDING_COPY.differentEmail,
      ONBOARDING_COPY.signOut,
    ]) {
      expect(button(label).className).toContain('min-h-[44px]');
    }
  });
});

describe('X8 switch from the make-a-workspace dialog', () => {
  it('a saved Creator whose stored step is the brand step opens on the brand screen', async () => {
    await render({ profile: SAVED_PROFILE, approverStage: 'brand' });
    expect(document.body.textContent).toContain('Who makes your posts?');
    expect(document.querySelector('#ob-brand')).not.toBeNull();
    // Nothing is stored on open: the dialog already stored the step.
    expect(onStep).not.toHaveBeenCalled();
    // The way back to Creator is still there.
    expect(button(ONBOARDING_COPY.changeRole)).toBeDefined();
  });
});
