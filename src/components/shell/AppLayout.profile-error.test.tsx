// @vitest-environment jsdom
// A failed profile read fails open into the app and warns once per failure,
// never on every render (Sentry FRONTEND-H: 28 events in 4 minutes).
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface WorkspaceState {
  loading: boolean;
  loaded: boolean;
  error: string | null;
  workspaces: Array<{ id: string; name: string; platform: string }>;
}

const { state, profile, retry, refetch, passthrough, nothing } = vi.hoisted(() => ({
  state: { current: null as WorkspaceState | null },
  profile: { loading: false, error: true },
  retry: vi.fn(),
  refetch: vi.fn(),
  passthrough: ({ children }: { children?: ReactNode }): ReactNode => children,
  nothing: (): null => null,
}));

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/chunk-reload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chunk-reload')>()),
  routeChunksLoaded: () => true,
  whenRouteChunksSettle: async () => undefined,
}));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: null, loading: false, failed: false, retry: vi.fn() }),
}));
vi.mock('@/components/shell/Sidebar', () => ({ Sidebar: nothing }));
vi.mock('@/components/shell/BottomTabs', () => ({ BottomTabs: nothing }));
vi.mock('@/components/shell/Topbar', () => ({ Topbar: nothing }));
vi.mock('@/components/shell/CommandPalette', () => ({ CommandPalette: nothing }));
vi.mock('@/components/shell/AvatarMenu', () => ({ AvatarMenu: nothing }));
vi.mock('@/components/shell/WorkspaceSwitcher', () => ({ WorkspaceSwitcher: nothing }));
vi.mock('@/components/storage/WorkspaceFullSheet', () => ({ WorkspaceFullSheet: nothing }));
vi.mock('@/components/ui/toast', () => ({ ToastProvider: passthrough, ToastViewport: nothing }));
vi.mock('@/components/chat/ChatStoreProvider', () => ({ ChatStoreProvider: passthrough }));
vi.mock('@/components/chat/ChatTabSignals', () => ({ ChatTabSignals: nothing }));
vi.mock('@/components/shell/InboxStoreProvider', () => ({ InboxStoreProvider: passthrough }));
vi.mock('@/components/onboarding/OnboardingFlow', () => ({ OnboardingFlow: nothing }));
vi.mock('@/components/induction/InductionGuide', () => ({ InductionGuide: nothing }));
vi.mock('@/components/induction/InductionProvider', () => ({ InductionProvider: passthrough }));
vi.mock('@/components/induction/useInductionData', () => ({
  useInductionData: () => ({
    status: 'ready',
    state: { step: null, done: true },
    setStep: vi.fn(),
  }),
}));
vi.mock('@/components/storage/useStorageWarning', () => ({
  useStorageWarning: () => ({ usage: null, dismissed: false, dismiss: vi.fn() }),
}));
vi.mock('@/lib/workspace-context-capability', () => ({ useWorkspaceCapability: () => true }));
vi.mock('@/lib/use-current-profile', () => ({
  useCurrentProfile: () => ({
    profile: profile.loading
      ? null
      : { display_name: 'A', avatar_url: null, profile_completed_at: '2026-01-01' },
    loading: profile.loading,
    error: profile.error,
    refetch,
  }),
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => {
    const s = state.current as WorkspaceState;
    return {
      ...s,
      workspaceId: s.workspaces[0]?.id ?? null,
      workspaceName: s.workspaces[0]?.name ?? null,
      workspaceDisplayName: s.workspaces[0]?.name ?? null,
      setActiveWorkspaceId: vi.fn(),
      refreshWorkspaces: vi.fn(async () => undefined),
      retryWorkspaces: retry,
    };
  },
}));

import { AppLayout } from '@/components/shell/AppLayout';
import { logger } from '@/lib/logger';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROWS = [{ id: 'ws-1', name: 'Acme', platform: 'linkedin' }];
const LOADED: WorkspaceState = { loading: false, loaded: true, error: null, workspaces: ROWS };
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(next: WorkspaceState): void {
  state.current = next;
  act(() => {
    root?.render(
      <MemoryRouter initialEntries={['/pipeline']}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/pipeline" element={<p>PIPELINE</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  });
}

const gateWarns = (): number =>
  vi
    .mocked(logger.warn)
    .mock.calls.filter(([msg]) => String(msg).startsWith('onboarding gate:')).length;
const gateErrors = (): number =>
  vi
    .mocked(logger.error)
    .mock.calls.filter(([msg]) => String(msg).startsWith('onboarding gate:')).length;

beforeEach(() => {
  profile.loading = false;
  profile.error = true;
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.error).mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('AppLayout onboarding gate on a failed profile read', () => {
  it('fails open into the app and warns exactly once across re-renders, never error', () => {
    render(LOADED);
    render(LOADED);
    render(LOADED);
    expect(host?.textContent ?? '').toContain('PIPELINE');
    expect(gateWarns()).toBe(1);
    expect(gateErrors()).toBe(0);
  });

  it('warns again only on a new false -> true change', () => {
    render(LOADED);
    profile.error = false;
    render(LOADED);
    render(LOADED);
    expect(gateWarns()).toBe(1);
    profile.error = true;
    render(LOADED);
    render(LOADED);
    expect(gateWarns()).toBe(2);
    expect(gateErrors()).toBe(0);
  });
});
