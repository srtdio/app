// @vitest-environment jsdom
// The shell's boot gate with a ceiling: a hung profile or workspace list
// reaches "Couldn't load. Try again." (never a forever loader), Try again
// re-runs the read in place, a failed list offers Try again (not "Reload the
// page"), and a list saved on the device still paints first.
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
  profile: { loading: false },
  retry: vi.fn(),
  refetch: vi.fn(),
  passthrough: ({ children }: { children?: ReactNode }): ReactNode => children,
  nothing: (): null => null,
}));

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
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
    error: false,
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

import { AppLayout, SHELL_GATE_MS } from '@/components/shell/AppLayout';
import { LOAD_FAILED_TEXT } from '@/components/auth/RouteGuards';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROWS = [{ id: 'ws-1', name: 'Acme', platform: 'linkedin' }];
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

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function tapTryAgain(): void {
  const button = Array.from(host?.querySelectorAll('button') ?? []).find(
    (b) => b.textContent === 'Try again',
  );
  expect(button).toBeDefined();
  act(() => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const text = (): string => host?.textContent ?? '';

beforeEach(() => {
  vi.useFakeTimers();
  profile.loading = false;
  retry.mockClear();
  refetch.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('AppLayout boot gate ceiling', () => {
  it('a hung workspace list reaches Try again at SHELL_GATE_MS; Try again re-runs it', () => {
    render({ loading: true, loaded: false, error: null, workspaces: [] });
    expect(text()).toContain('Loading');

    advance(SHELL_GATE_MS - 1);
    expect(text()).not.toContain(LOAD_FAILED_TEXT);
    advance(1);
    expect(text()).toContain(LOAD_FAILED_TEXT);

    tapTryAgain();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(refetch).not.toHaveBeenCalled();
    // Back on the loader, with a fresh ceiling.
    expect(text()).toContain('Loading');
    expect(text()).not.toContain(LOAD_FAILED_TEXT);
  });

  it('a hung profile read reaches Try again; Try again re-reads the profile', () => {
    profile.loading = true;
    render({ loading: false, loaded: true, error: null, workspaces: ROWS });
    advance(SHELL_GATE_MS);
    expect(text()).toContain(LOAD_FAILED_TEXT);

    tapTryAgain();
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('the gate opens as soon as the reads land: no failure, the page paints', () => {
    render({ loading: true, loaded: false, error: null, workspaces: [] });
    advance(SHELL_GATE_MS - 1);
    render({ loading: false, loaded: true, error: null, workspaces: ROWS });
    advance(SHELL_GATE_MS);
    expect(text()).toContain('PIPELINE');
    expect(text()).not.toContain(LOAD_FAILED_TEXT);
  });
});

describe('AppLayout failed workspace list', () => {
  it('shows Try again (not "Reload the page") and re-runs the list in place', () => {
    render({ loading: false, loaded: false, error: 'TimeoutError', workspaces: [] });
    expect(text()).toContain(LOAD_FAILED_TEXT);
    expect(text()).not.toContain('Reload the page');

    tapTryAgain();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('a list saved on the device paints first, with no loader or failure', () => {
    // From the device cache: loaded while the fresh list is still loading.
    render({ loading: true, loaded: true, error: null, workspaces: ROWS });
    expect(text()).toContain('PIPELINE');
    advance(SHELL_GATE_MS);
    expect(text()).toContain('PIPELINE');
    expect(text()).not.toContain(LOAD_FAILED_TEXT);
  });
});
