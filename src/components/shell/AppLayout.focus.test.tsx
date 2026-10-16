// @vitest-environment jsdom
import { act, useEffect, useState } from 'react';
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

const { state, storage, mounts, passthrough, nothing } = vi.hoisted(() => ({
  state: { current: null as WorkspaceState | null },
  storage: {
    usage: null as {
      usedBytes: number;
      warnAtBytes: number;
      warn: boolean;
      exempt: boolean;
    } | null,
  },
  mounts: { count: 0 },
  passthrough: ({ children }: { children?: ReactNode }): ReactNode => children,
  nothing: (): null => null,
}));

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: null, loading: false }),
}));
vi.mock('@/components/shell/Sidebar', () => ({ Sidebar: nothing }));
vi.mock('@/components/shell/BottomTabs', () => ({ BottomTabs: nothing }));
vi.mock('@/components/shell/Topbar', () => ({ Topbar: nothing }));
vi.mock('@/components/shell/CommandPalette', () => ({ CommandPalette: nothing }));
vi.mock('@/components/shell/AvatarMenu', () => ({ AvatarMenu: nothing }));
vi.mock('@/components/shell/WorkspaceSwitcher', () => ({ WorkspaceSwitcher: nothing }));
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
  useStorageWarning: () => ({ usage: storage.usage, dismissed: false, dismiss: vi.fn() }),
}));
vi.mock('@/lib/workspace-context-capability', () => ({ useWorkspaceCapability: () => true }));
vi.mock('@/lib/use-current-profile', () => ({
  useCurrentProfile: () => ({
    profile: { display_name: 'A', avatar_url: null, profile_completed_at: '2026-01-01' },
    loading: false,
    error: null,
    refetch: vi.fn(),
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
    };
  },
}));

import { AppLayout } from '@/components/shell/AppLayout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Stands in for the routed page (PostDetailPage + Comments): it holds rows and
// a composer draft in local state, so a remount would wipe both.
function RoutedPage() {
  const [draft, setDraft] = useState('');
  useEffect(() => {
    mounts.count += 1;
  }, []);
  return (
    <div>
      <p>comment row one</p>
      <textarea aria-label="draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
    </div>
  );
}

const ROWS = [{ id: 'ws-1', name: 'Acme', platform: 'linkedin' }];
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(next: WorkspaceState): void {
  state.current = next;
  act(() => {
    root?.render(
      <MemoryRouter initialEntries={['/posts/p1']}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/posts/:postId" element={<RoutedPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  });
}

function typeDraft(value: string): void {
  const el = host?.querySelector('textarea') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const draftValue = (): string | undefined => host?.querySelector('textarea')?.value;
const text = (): string => host?.textContent ?? '';

beforeEach(() => {
  mounts.count = 0;
  storage.usage = null;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('AppLayout across workspace re-lists', () => {
  it('shows the full-screen Loading only for the initial load', () => {
    render({ loading: true, loaded: false, error: null, workspaces: [] });
    expect(text()).toBe('Loading');
    expect(mounts.count).toBe(0);
  });

  it('keeps the Outlet mounted, with its rows and draft, through a later re-list', () => {
    render({ loading: false, loaded: true, error: null, workspaces: ROWS });
    typeDraft('half-written comment');
    expect(mounts.count).toBe(1);

    render({ loading: true, loaded: true, error: null, workspaces: ROWS });
    expect(text()).not.toBe('Loading');
    render({ loading: false, loaded: true, error: null, workspaces: ROWS });

    expect(mounts.count).toBe(1);
    expect(text()).toContain('comment row one');
    expect(draftValue()).toBe('half-written comment');
  });

  it('keeps the shell on a failed re-list after the initial load', () => {
    render({ loading: false, loaded: true, error: null, workspaces: ROWS });
    typeDraft('keep me');

    render({ loading: false, loaded: true, error: 'network down', workspaces: ROWS });

    expect(text()).not.toContain("We couldn't load your workspaces");
    expect(mounts.count).toBe(1);
    expect(draftValue()).toBe('keep me');
  });

  it('shows the error screen when the initial list fails', () => {
    render({ loading: false, loaded: false, error: 'network down', workspaces: [] });
    expect(text()).toContain("We couldn't load your workspaces");
  });

  it('a user change (loaded resets) returns to the full-screen Loading', () => {
    render({ loading: false, loaded: true, error: null, workspaces: ROWS });
    expect(mounts.count).toBe(1);

    render({ loading: true, loaded: false, error: null, workspaces: ROWS });

    expect(text()).toBe('Loading');
  });

  it('shows the storage banner above the page without remounting the Outlet or Loading', () => {
    render({ loading: false, loaded: true, error: null, workspaces: ROWS });
    typeDraft('keep me too');
    expect(host?.querySelector('[role="status"]')).toBeNull();

    storage.usage = { usedBytes: 820 * 1024 * 1024, warnAtBytes: 1, warn: true, exempt: false };
    render({ loading: false, loaded: true, error: null, workspaces: ROWS });

    const banner = host?.querySelector('[role="status"]');
    expect(banner?.textContent).toContain('Deleted files still count toward storage.');
    expect(banner?.closest('main')).toBeNull();
    expect(text()).not.toBe('Loading');
    expect(mounts.count).toBe(1);
    expect(draftValue()).toBe('keep me too');
  });
});
