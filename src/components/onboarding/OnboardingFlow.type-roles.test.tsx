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

function classesOf(text: string): string[] {
  const el = [...document.querySelectorAll<HTMLElement>('body *')].find(
    (node) => node.textContent?.trim() === text && node.children.length === 0,
  );
  if (el === undefined) throw new Error(`no element with text ${text}`);
  return el.className.split(/\s+/);
}

describe('OnboardingFlow type roles', () => {
  it('title is the screen header: text-lg font-semibold', async () => {
    await render({});
    const title = document.querySelector('h1');
    expect(title?.textContent).toBe(ONBOARDING_COPY.sideTitle);
    const classes = (title?.className ?? '').split(/\s+/);
    expect(classes).toContain('text-lg');
    expect(classes).toContain('font-semibold');
  });

  it('the step counter is meta: text-sm text-fg-3', async () => {
    await render({});
    const step = document.querySelector('[data-onboarding-step]');
    const classes = (step?.className ?? '').split(/\s+/);
    expect(classes).toContain('text-sm');
    expect(classes).toContain('text-fg-3');
  });

  it('option tile titles are card titles: text-base font-medium', async () => {
    await render({});
    const tile = classesOf('Creator');
    expect(tile).toContain('text-base');
    expect(tile).toContain('font-medium');
    expect(tile).not.toContain('font-semibold');
  });

  it('the preview heading is the section label', async () => {
    await render({});
    const label = classesOf('How you will appear');
    for (const want of [
      'text-sm',
      'font-semibold',
      'uppercase',
      'tracking-[0.06em]',
      'text-fg-2',
    ]) {
      expect(label).toContain(want);
    }
  });
});
