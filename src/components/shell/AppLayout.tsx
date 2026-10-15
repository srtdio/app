import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Sidebar } from '@/components/shell/Sidebar';
import { BottomTabs } from '@/components/shell/BottomTabs';
import { Topbar } from '@/components/shell/Topbar';
import { CommandPalette } from '@/components/shell/CommandPalette';
import { AvatarMenu } from '@/components/shell/AvatarMenu';
import { WorkspaceSwitcher } from '@/components/shell/WorkspaceSwitcher';
import { ToastProvider, ToastViewport } from '@/components/ui/toast';
import { ChatStoreProvider } from '@/components/chat/ChatStoreProvider';
import { ChatTabSignals } from '@/components/chat/ChatTabSignals';
import { InboxStoreProvider } from '@/components/shell/InboxStoreProvider';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconPipeline } from '@/components/ui/icons';
import { OnboardingFlow } from '@/components/onboarding/OnboardingFlow';
import { InductionGuide } from '@/components/induction/InductionGuide';
import { InductionProvider } from '@/components/induction/InductionProvider';
import { useInductionData } from '@/components/induction/useInductionData';
import { approverStageOf, type ApproverStage } from '@/lib/induction';
import { dispatchSorted } from '@/lib/events';
import { useWorkspace } from '@/lib/workspace-context';
import { useWorkspaceCapability } from '@/lib/workspace-context-capability';
import { useCurrentProfile } from '@/lib/use-current-profile';
import { logger } from '@/lib/logger';
import { cn } from '@/lib/cn';

/** True on /chat with an open thread (?channel=<id>); mobile then drops the shell chrome. */
export function isThreadRoute(pathname: string, search: URLSearchParams): boolean {
  const channel = search.get('channel');
  return pathname === '/chat' && channel !== null && channel !== '';
}

/**
 * Shell chrome classes for a render. Inside a chat thread, below md, the Topbar
 * is hidden, BottomTabs are not rendered and main drops its tab-bar padding;
 * md and up is unchanged (BottomTabs are md:hidden anyway). Derived from the URL
 * in the same render, so the first paint is already correct.
 */
export function shellChrome(threadOpen: boolean): {
  topbarClassName: string;
  showBottomTabs: boolean;
  mainClassName: string;
} {
  return {
    topbarClassName: threadOpen ? 'hidden md:contents' : 'contents',
    showBottomTabs: !threadOpen,
    mainClassName: cn(
      'flex-1 overflow-y-auto overflow-x-hidden',
      threadOpen ? 'pb-0' : 'pb-[calc(56px+env(safe-area-inset-bottom))] md:pb-0',
    ),
  };
}

export function AppLayout() {
  const {
    workspaceName,
    workspaceDisplayName,
    workspaces,
    loading,
    workspaceId,
    setActiveWorkspaceId,
    refreshWorkspaces,
    error: workspaceError,
  } = useWorkspace();
  const navigate = useNavigate();
  const {
    profile,
    loading: profileLoading,
    error: profileError,
    refetch: refetchProfile,
  } = useCurrentProfile();
  const [searchParams, setSearchParams] = useSearchParams();
  const { pathname } = useLocation();
  const chrome = shellChrome(isThreadRoute(pathname, searchParams));
  const [paletteOpen, setPaletteOpen] = useState(false);
  // New brief is a client action: shown only where the role holds brief.create.
  const briefCreate = useWorkspaceCapability('brief.create');
  const canCreateBrief = briefCreate === true;
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

  // The induction: induction_state for the active workspace (null before one
  // exists). With no workspace yet, the stored step decides between the
  // Creator's shell (make the workspace) and the approver's screens.
  const induction = useInductionData(workspaceId);
  const noWorkspace = !loading && workspaceError === null && workspaces.length === 0;
  const inductionPending = noWorkspace && induction.status === 'loading';
  const approverStage: ApproverStage = noWorkspace ? approverStageOf(induction.state) : 'none';

  const onboardingNeeded =
    !profileLoading &&
    !loading &&
    !profileError &&
    // A failed list also comes back empty: never read that as "no workspace".
    workspaceError === null &&
    profile !== null &&
    !inductionPending &&
    (profile.profile_completed_at === null || approverStage !== 'none');
  const [flow, setFlow] = useState<{
    workspaceId: string | null;
    workspaceName: string | null;
    approverStage: ApproverStage;
    finishing: string | null;
    finishError: string | null;
  } | null>(null);
  // Close the flow once the finish refetch has landed, then open its destination.
  // A Creator may finish with no workspace yet: the shell then asks for one.
  useEffect(() => {
    if (flow === null || flow.finishing === null) return;
    if (loading || profileLoading) return;
    // The refetch failed: hand the flow its buttons back with a message.
    if (workspaceError !== null || profileError || profile === null) {
      setFlow({
        ...flow,
        finishing: null,
        finishError: "We couldn't open your workspace. Check your connection and try again.",
      });
      return;
    }
    if (profile.profile_completed_at === null) return;
    const to = flow.finishing;
    setFlow(null);
    navigate(to, { replace: true });
  }, [flow, loading, profileLoading, profile, profileError, workspaceError, navigate]);

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

  // Onboarding gate: an unfinished profile or no workspace opens OnboardingFlow
  // full screen, before any chrome. It is opened in render (no shell frame first)
  // and its workspace context is frozen at open, then it stays mounted until the
  // finish refetch shows a complete profile and a workspace, so the flow never
  // remounts mid-way or flashes the shell.
  if (flow === null && (profileLoading || loading || inductionPending)) {
    return (
      <div className="min-h-full w-full grid place-items-center bg-bg">
        <span className="text-sm text-fg-3">Loading</span>
      </div>
    );
  }
  if (onboardingNeeded && flow === null) {
    setFlow({
      workspaceId: workspaces.length > 0 ? workspaceId : null,
      workspaceName: workspaces.length > 0 ? workspaceDisplayName : null,
      approverStage,
      finishing: null,
      finishError: null,
    });
    return null;
  }
  if (flow !== null) {
    return (
      <OnboardingFlow
        profile={profile}
        workspaceId={flow.workspaceId}
        workspaceName={flow.workspaceName}
        approverStage={flow.approverStage}
        onStep={induction.setStep}
        finishError={flow.finishError}
        onFinish={(to) => {
          setFlow({ ...flow, finishing: to, finishError: null });
          void refreshWorkspaces();
          refetchProfile();
        }}
      />
    );
  }
  // Fail open on a profile load error: a transient fetch failure must never trap
  // the user behind onboarding. We fall through to the app here and the gate runs
  // again on the next mount; the failure was already logged in useCurrentProfile.
  if (profileError) {
    logger.error('onboarding gate: profile load failed, falling through to app');
  }

  // A failed workspace list is not "no workspace": say so instead of a shell.
  if (!loading && workspaceError !== null && workspaces.length === 0) {
    return (
      <div className="grid h-full w-full place-items-center bg-bg px-6">
        <EmptyState
          icon={<IconPipeline />}
          title="We couldn't load your workspaces"
          description="Check your connection, then reload the page."
        />
      </div>
    );
  }

  // No workspace yet: the real shell with an empty main, its slot opening the
  // create dialog. Chat and inbox mount only once a workspace exists.
  if (noWorkspace) {
    return (
      <ToastProvider>
        <InductionProvider data={induction} workspaceId={null} workspaceLabel="">
          <div className="flex h-full">
            <div className="flex flex-1 min-w-0 flex-col h-full">
              <Topbar
                workspaceName={null}
                {...(profile !== null ? { currentUserName: profile.display_name } : {})}
                currentUserAvatarUrl={profile?.avatar_url ?? null}
                onOpenPalette={() => undefined}
                onOpenAvatar={() => setAvatarOpen(true)}
                onCreateWorkspace={() => dispatchSorted('sorted:switch-workspace')}
              />
              <main className={chrome.mainClassName} />
            </div>
            <ToastViewport />
            <AvatarMenu open={avatarOpen} onClose={() => setAvatarOpen(false)} />
            <WorkspaceSwitcher />
            <InductionGuide tabsShown={false} />
          </div>
        </InductionProvider>
      </ToastProvider>
    );
  }

  // ChatStoreProvider sits inside ToastProvider (it fires toasts) and the router
  // (toast presses navigate), and wraps the whole shell so the always-on chat
  // store is live across routes and the Chat-tab badge (a later PR) can read it.
  return (
    <ToastProvider>
      <InductionProvider
        data={induction}
        workspaceId={workspaceId}
        workspaceLabel={workspaceDisplayName ?? ''}
        canCreateBrief={briefCreate}
      >
        <ChatStoreProvider>
          <ChatTabSignals />
          <InboxStoreProvider>
            <div className="flex h-full">
              <Sidebar workspaceName={workspaceDisplayName} clientName={workspaceName} />
              <div className="flex flex-1 min-w-0 flex-col h-full">
                <div className={chrome.topbarClassName}>
                  <Topbar
                    workspaceName={workspaceDisplayName}
                    canCreateBrief={canCreateBrief}
                    {...(profile !== null ? { currentUserName: profile.display_name } : {})}
                    currentUserAvatarUrl={profile?.avatar_url ?? null}
                    onOpenPalette={() => setPaletteOpen(true)}
                    onOpenAvatar={() => setAvatarOpen(true)}
                  />
                </div>
                <main className={chrome.mainClassName}>{switchPending ? null : <Outlet />}</main>
              </div>
              {chrome.showBottomTabs ? <BottomTabs /> : null}
              <ToastViewport />
              <CommandPalette
                open={paletteOpen}
                onClose={() => setPaletteOpen(false)}
                canCreateBrief={canCreateBrief}
              />
              <AvatarMenu open={avatarOpen} onClose={() => setAvatarOpen(false)} />
              <WorkspaceSwitcher />
              <InductionGuide tabsShown={chrome.showBottomTabs} />
            </div>
          </InboxStoreProvider>
        </ChatStoreProvider>
      </InductionProvider>
    </ToastProvider>
  );
}
