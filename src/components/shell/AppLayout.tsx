import { useEffect, useRef, useState } from 'react';
import { Outlet, useSearchParams } from 'react-router-dom';
import { Sidebar } from '@/components/shell/Sidebar';
import { BottomTabs } from '@/components/shell/BottomTabs';
import { Topbar } from '@/components/shell/Topbar';
import { CommandPalette } from '@/components/shell/CommandPalette';
import { AvatarMenu } from '@/components/shell/AvatarMenu';
import { WorkspaceSwitcher } from '@/components/shell/WorkspaceSwitcher';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconPipeline } from '@/components/ui/icons';
import { OnboardingProfileForm } from '@/components/onboarding/OnboardingProfileForm';
import { useWorkspace } from '@/lib/workspace-context';
import { useCurrentProfile } from '@/lib/use-current-profile';
import { logger } from '@/lib/logger';

export function AppLayout() {
  const { workspaceName, workspaces, loading, workspaceId, setActiveWorkspaceId } = useWorkspace();
  const {
    profile,
    loading: profileLoading,
    error: profileError,
    refetch: refetchProfile,
  } = useCurrentProfile();
  const [searchParams, setSearchParams] = useSearchParams();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);

  // Email deep-link: ?w={workspaceId} sets the active workspace before the entity
  // route renders. Fired once per distinct w via a ref guard (no setSearchParams
  // loop), and only 'w' is stripped afterward so any sibling deep-link param
  // (comment/channel/asset) survives for its own consumer.
  const handledWorkspaceParam = useRef<string | null>(null);
  useEffect(() => {
    if (loading) return;
    const w = searchParams.get('w');
    if (w === null || w === '') return;
    if (handledWorkspaceParam.current === w) return;
    handledWorkspaceParam.current = w;
    if (workspaces.some((x) => x.id === w) && w !== workspaceId) {
      setActiveWorkspaceId(w);
    }
    const next = new URLSearchParams(searchParams);
    next.delete('w');
    setSearchParams(next, { replace: true });
  }, [loading, searchParams, workspaces, workspaceId, setActiveWorkspaceId, setSearchParams]);

  // While a deep-link workspace switch is pending (the target exists but is not
  // yet active), hold the Outlet so the entity never mounts under the wrong
  // tenant for a frame; the switch + strip above resolve it on the next render.
  const wParam = searchParams.get('w');
  const switchPending =
    !loading &&
    wParam !== null &&
    wParam !== '' &&
    workspaces.some((x) => x.id === wParam) &&
    wParam !== workspaceId;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  // Onboarding gate. Runs before the workspace checks and escapes the chrome with
  // an early return, exactly like the zero-workspace EmptyState below. The form is
  // workspace-independent, so we never read useWorkspace from it.
  if (profileLoading) {
    // Reuse the shell's minimal centered loading state (RouteGuards' SessionLoading).
    return (
      <div className="min-h-full w-full grid place-items-center bg-bg">
        <span className="text-sm text-fg-3">Loading</span>
      </div>
    );
  }
  if (!profileError && profile !== null && profile.profile_completed_at === null) {
    return (
      <OnboardingProfileForm
        initialDisplayName={profile.display_name}
        initialDesignation={profile.designation}
        initialEmailOptIn={profile.email_opt_in}
        onComplete={refetchProfile}
      />
    );
  }
  // Fail open on a profile load error: a transient fetch failure must never trap
  // the user behind onboarding. We fall through to the app here and the gate runs
  // again on the next mount; the failure was already logged in useCurrentProfile.
  if (profileError) {
    logger.error('onboarding gate: profile load failed, falling through to app');
  }

  // An authed user with zero workspaces is a benign state, not a crash: show a
  // calm full-page empty state instead of an empty board.
  if (!loading && workspaces.length === 0) {
    return (
      <div className="grid h-full w-full place-items-center bg-bg px-6">
        <EmptyState
          icon={<IconPipeline />}
          title="No workspace yet"
          description="You are not a member of any workspace. An invite will bring you into one."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <Sidebar workspaceName={workspaceName} />
      <div className="flex flex-1 min-w-0 flex-col h-full">
        <Topbar
          workspaceName={workspaceName}
          currentUserName={profile?.display_name ?? undefined}
          currentUserAvatarUrl={profile?.avatar_url ?? null}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenAvatar={() => setAvatarOpen(true)}
        />
        <main className="flex-1 overflow-y-auto pb-[56px] md:pb-0">
          {switchPending ? null : <Outlet />}
        </main>
      </div>
      <BottomTabs />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <AvatarMenu open={avatarOpen} onClose={() => setAvatarOpen(false)} />
      <WorkspaceSwitcher />
    </div>
  );
}
