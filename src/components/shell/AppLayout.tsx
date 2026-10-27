import { mark } from '@/lib/perf-marks';
import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Sidebar } from '@/components/shell/Sidebar';
import { BottomTabs } from '@/components/shell/BottomTabs';
import { Topbar } from '@/components/shell/Topbar';
import { CommandPalette, type PaletteCloseReason } from '@/components/shell/CommandPalette';
import { isPaletteShortcut, isTextEntry, usesCmdKey } from '@/lib/search/palette-keys';
import { AvatarMenu } from '@/components/shell/AvatarMenu';
import { approverSwitchShown, WorkspaceSwitcher } from '@/components/shell/WorkspaceSwitcher';
import { ToastProvider, ToastViewport } from '@/components/ui/toast';
import { StorageWarningBanner } from '@/components/storage/StorageWarningBanner';
import { WorkspaceFullSheet } from '@/components/storage/WorkspaceFullSheet';
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
import { useSession } from '@/lib/session-context';
import { useRecentRecorder } from '@/lib/recent-items';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { cn } from '@/lib/cn';
import { setPrefetchContext } from '@/lib/prefetch-context';
import { routeChunksLoaded, whenRouteChunksSettle } from '@/lib/chunk-reload';
import { SessionLoading } from '@/components/auth/RouteGuards';
import { MarksPanel } from '@/components/dev/MarksPanel';

/** True on /chat with an open thread (?channel=<id>); mobile then drops the shell chrome. */
export function isThreadRoute(pathname: string, search: URLSearchParams): boolean {
  const channel = search.get('channel');
  return pathname === '/chat' && channel !== null && channel !== '';
}

// Post detail (/posts/:id, /p/:ref) and Brief detail (/briefs/:id, /b/:ref).
const DETAIL_ROUTE = /^\/(posts|p|briefs|b)\/[^/]+\/?$/;

/**
 * True on a Post detail or Brief detail route; mobile then drops the shell
 * chrome as a chat thread does (the page carries its own back arrow).
 */
export function isDetailRoute(pathname: string): boolean {
  return DETAIL_ROUTE.test(pathname);
}

/**
 * Shell chrome classes for a render. Inside a chat thread or on a Post or
 * Brief detail page, below md, the Topbar
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

// The first shell paint of this page load; still loading there means it
// painted from the device cache.
let firstShellPainted = false;

// One ToastProvider for every branch below: a toast fired as the shell swaps
// branches (e.g. "<name> deleted for good" as the last workspace goes, through
// the induction read's blank frame) survives the swap.
export function AppLayout() {
  return (
    <ToastProvider>
      <AppLayoutBody />
    </ToastProvider>
  );
}

function AppLayoutBody() {
  const {
    workspaceName,
    workspaceDisplayName,
    workspaces,
    loading,
    loaded,
    workspaceId,
    workspaceKey,
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
  const { pathname, search } = useLocation();
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const chrome = shellChrome(isThreadRoute(pathname, searchParams) || isDetailRoute(pathname));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteOpenRef = useRef(false);
  paletteOpenRef.current = paletteOpen;
  const paletteInputRef = useRef<HTMLInputElement>(null);
  // Where the user was when search opened: Cancel / Esc puts focus back there.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // One tap opens search with the cursor in the field: the palette renders
  // inside this handler (flushSync) and its field is focused right here, in
  // the tap, the only place iOS Safari (and the installed app) raises the keyboard.
  const openPalette = useCallback((): void => {
    const was = document.activeElement;
    returnFocusRef.current = was instanceof HTMLElement && was !== document.body ? was : null;
    flushSync(() => setPaletteOpen(true));
    paletteInputRef.current?.focus({ preventScroll: true });
  }, []);
  const closePalette = useCallback((reason: PaletteCloseReason): void => {
    setPaletteOpen(false);
    const back = returnFocusRef.current;
    returnFocusRef.current = null;
    // A picked result moves on to its target; a dismiss returns where the user was.
    if (reason === 'dismiss' && back !== null && back.isConnected) {
      back.focus({ preventScroll: true });
    }
  }, []);
  // Induction tailors its brief steps to whether the role holds brief.create.
  const briefCreate = useWorkspaceCapability('brief.create');
  const [avatarOpen, setAvatarOpen] = useState(false);

  // Press prefetch for data (src/lib/route-data.ts) needs who and where: set
  // once the session and the active workspace are known, cleared when either
  // goes (signout, no workspace, unmount).
  useEffect(() => {
    if (userId === null || workspaceId === null) {
      setPrefetchContext(null);
      return;
    }
    mark('prefetch:ctx');
    setPrefetchContext({ userId, workspaceId });
    return () => setPrefetchContext(null);
  }, [userId, workspaceId]);

  // The first page's chunk (started at boot by main.tsx): the full-screen
  // loader stays up until it has landed, so boot shows one loader until the
  // page and never the shell with a second loader inside main. Only the first
  // mount waits; later navigations are the routes' own business.
  // The path at mount only: a later path never re-holds the shell.
  const [firstPath] = useState(pathname);
  const [firstRouteReady, setFirstRouteReady] = useState(() => routeChunksLoaded(firstPath));
  useEffect(() => {
    if (firstRouteReady) return;
    let active = true;
    void whenRouteChunksSettle(firstPath).then(() => {
      mark('shell:firstroute');
      if (active) setFirstRouteReady(true);
    });
    return () => {
      active = false;
    };
  }, [firstRouteReady, firstPath]);

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
  // A shell painted from the device cache is still loading: a ?w= for another
  // workspace holds the Outlet until the fresh list decides.
  const wParam = searchParams.get('w');
  const switchPending =
    wParam !== null &&
    wParam !== '' &&
    wParam !== workspaceId &&
    (loading ? loaded : workspaces.some((x) => x.id === wParam));

  // The palette's recents: this is the one place opens are recorded.
  useRecentRecorder({
    client: supabase,
    pathname,
    search,
    workspaceId,
    workspaceKey,
    userId,
    paused: loading || switchPending,
  });

  // The induction: induction_state for the active workspace (null before one
  // exists). With no workspace yet, the stored step decides between the
  // Creator's shell (make the workspace) and the approver's screens.
  const induction = useInductionData(workspaceId);
  // Only the first list blocks the shell. A later re-list (e.g. after creating a
  // workspace) keeps the shell and the Outlet mounted, so comments, drafts and
  // scroll survive it.
  const initialLoading = loading && !loaded;
  const noWorkspace = !initialLoading && workspaceError === null && workspaces.length === 0;
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
        finishError: "Couldn't open your workspace. Try again.",
      });
      return;
    }
    if (profile.profile_completed_at === null) return;
    const to = flow.finishing;
    setFlow(null);
    navigate(to, { replace: true });
  }, [flow, loading, profileLoading, profile, profileError, workspaceError, navigate]);

  // Cmd+K (Apple) / Ctrl+K (others) opens search from anywhere, and closes it
  // from its own field; typing in any other text field never triggers it.
  useEffect(() => {
    const cmdKey = usesCmdKey(navigator.platform || navigator.userAgent);
    function onKeyDown(event: KeyboardEvent): void {
      if (!isPaletteShortcut(event, cmdKey)) return;
      const inPalette = event.target !== null && event.target === paletteInputRef.current;
      if (!inPalette && isTextEntry(event.target)) return;
      event.preventDefault();
      if (paletteOpenRef.current) closePalette('dismiss');
      else openPalette();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [openPalette, closePalette]);

  // Onboarding gate: an unfinished profile or no workspace opens OnboardingFlow
  // full screen, before any chrome. It is opened in render (no shell frame first)
  // and its workspace context is frozen at open, then it stays mounted until the
  // finish refetch shows a complete profile and a workspace, so the flow never
  // remounts mid-way or flashes the shell.
  // The same loader element as the session wait and the chunk fallbacks
  // (RouteGuards' SessionLoading): boot shows one loader, never a swap.
  if (flow === null && (profileLoading || initialLoading || inductionPending)) {
    return <SessionLoading />;
  }
  mark('shell:gate-open');
  if (onboardingNeeded && flow === null) {
    mark('shell:onboarding');
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

  // A failed initial workspace list is not "no workspace": say so instead of a
  // shell. A failed re-list after that keeps the loaded shell.
  if (!loaded && !loading && workspaceError !== null) {
    return (
      <div className="grid h-full w-full place-items-center bg-bg px-6">
        <EmptyState
          icon={<IconPipeline />}
          title="Couldn't load your workspaces. Try again."
          description="Reload the page."
        />
      </div>
    );
  }

  // No workspace yet: the real shell with an empty main, its slot opening the
  // create dialog. Chat and inbox mount only once a workspace exists.
  if (noWorkspace) {
    return (
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
          {/* A self-signed-up Creator can still say "I approve posts": storing the
              approver's brand step flips approverStageOf to 'brand', so the
              onboarding gate above opens OnboardingFlow on the brand screen. */}
          <WorkspaceSwitcher
            {...(approverSwitchShown({ workspaceCount: workspaces.length, state: induction.state })
              ? { onInductionStep: induction.setStep }
              : {})}
          />
          <InductionGuide />
        </div>
      </InductionProvider>
    );
  }

  // The first page's chunk is still on its way: keep the boot loader up
  // rather than paint the shell around a second loader in main.
  if (!firstRouteReady) return <SessionLoading />;

  // The shell paints from the list and profile this device saved, before the
  // network answers (the fresh ones replace them in place).
  if (!firstShellPainted) {
    firstShellPainted = true;
    if (loading) mark('device-cache:shell-from-cache');
  }

  // ChatStoreProvider sits inside AppLayout's ToastProvider (it fires toasts) and the router
  // (toast presses navigate), and wraps the whole shell so the always-on chat
  // store is live across routes and the Chat-tab badge (a later PR) can read it.
  return (
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
                  {...(profile !== null ? { currentUserName: profile.display_name } : {})}
                  currentUserAvatarUrl={profile?.avatar_url ?? null}
                  onOpenPalette={openPalette}
                  onOpenAvatar={() => setAvatarOpen(true)}
                />
              </div>
              {/* Its own sibling above main: showing it never remounts the Outlet. */}
              <StorageWarningBanner />
              {/* Keyed by workspace: a switch remounts the route, so the new workspace
                  paints its own kept view or skeleton and nothing of the old one stays. */}
              <main className={chrome.mainClassName}>
                {switchPending ? null : <Outlet key={workspaceId ?? 'none'} />}
              </main>
            </div>
            {chrome.showBottomTabs ? <BottomTabs /> : null}
            <ToastViewport />
            <CommandPalette
              open={paletteOpen}
              onClose={closePalette}
              inputRef={paletteInputRef}
              workspaceId={workspaceId}
              workspaceKey={workspaceKey}
              userId={userId}
            />
            <AvatarMenu open={avatarOpen} onClose={() => setAvatarOpen(false)} />
            <WorkspaceSwitcher />
            <WorkspaceFullSheet />
            <InductionGuide />
            <MarksPanel />
          </div>
        </InboxStoreProvider>
      </ChatStoreProvider>
    </InductionProvider>
  );
}
