import { Suspense, useEffect, type ReactElement, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { TestSiteAnywhereStart } from '@/components/test-site/TestSiteAnywhereStart';
import { RequireAuth, RequireGuest, SessionLoading } from '@/components/auth/RouteGuards';
import { HomeGate } from '@/components/home/HomeGate';
import { SessionProvider } from '@/lib/session-context';
import { lazyRoute, whenIdle } from '@/lib/chunk-reload';
import { warmMonoFont } from '@/lib/fonts';

// Chat times and dates are mono: load the face at boot, before any thread paints.
warmMonoFont();

// Every page is its own chunk (React.lazy), so sign in, sign up and invite
// never download the shell, chat, pipeline, posts, plan, assets or briefs.
// Each loader is a named function so the idle prefetch below warms the exact
// chunk the route later asks for.
const loadPipeline = () => import('@/components/pages/PipelinePage');
const loadChat = () => import('@/components/pages/ChatPage');

const PipelinePage = lazyRoute(loadPipeline, (m) => m.PipelinePage);
const ChatPage = lazyRoute(loadChat, (m) => m.ChatPage);
const PostDetailPage = lazyRoute(
  () => import('@/components/pages/PostDetailPage'),
  (m) => m.PostDetailPage,
);
const BriefsPage = lazyRoute(
  () => import('@/components/pages/BriefsPage'),
  (m) => m.BriefsPage,
);
const BriefDetailPage = lazyRoute(
  () => import('@/components/pages/BriefDetailPage'),
  (m) => m.BriefDetailPage,
);
const AssetsPage = lazyRoute(
  () => import('@/components/pages/AssetsPage'),
  (m) => m.AssetsPage,
);
const RecentlyDeletedPage = lazyRoute(
  () => import('@/components/pages/RecentlyDeletedPage'),
  (m) => m.RecentlyDeletedPage,
);
const SettingsPage = lazyRoute(
  () => import('@/components/pages/SettingsPage'),
  (m) => m.SettingsPage,
);
const HelpPage = lazyRoute(
  () => import('@/components/pages/HelpPage'),
  (m) => m.HelpPage,
);
const NotificationsPage = lazyRoute(
  () => import('@/components/pages/NotificationsPage'),
  (m) => m.NotificationsPage,
);
const PlanTabPage = lazyRoute(
  () => import('@/components/pages/PlanTabPage'),
  (m) => m.PlanTabPage,
);
const PlanBesideLayout = lazyRoute(
  () => import('@/components/pages/PlanPage'),
  (m) => m.PlanBesideLayout,
);
const PlanPage = lazyRoute(
  () => import('@/components/pages/PlanPage'),
  (m) => m.PlanPage,
);
const ActivityRedirect = lazyRoute(
  () => import('@/components/shell/ActivityRedirect'),
  (m) => m.ActivityRedirect,
);
const PostRefResolver = lazyRoute(
  () => import('@/components/refs/PostRefResolver'),
  (m) => m.PostRefResolver,
);
const BriefRefResolver = lazyRoute(
  () => import('@/components/refs/BriefRefResolver'),
  (m) => m.BriefRefResolver,
);
const SignInPage = lazyRoute(
  () => import('@/components/auth/SignInPage'),
  (m) => m.SignInPage,
);
const SignUpPage = lazyRoute(
  () => import('@/components/auth/SignUpPage'),
  (m) => m.SignUpPage,
);
const AuthCallbackPage = lazyRoute(
  () => import('@/components/auth/AuthCallbackPage'),
  (m) => m.AuthCallbackPage,
);
const LegalPolicyPage = lazyRoute(
  () => import('@/components/auth/LegalPolicyPage'),
  (m) => m.LegalPolicyPage,
);
const UnsubscribePage = lazyRoute(
  () => import('@/components/unsubscribe/UnsubscribePage'),
  (m) => m.UnsubscribePage,
);
const AcceptInvitePage = lazyRoute(
  () => import('@/components/auth/AcceptInvitePage'),
  (m) => m.AcceptInvitePage,
);
const TestInviteePage = lazyRoute(
  () => import('@/components/test-site/TestInviteePage'),
  (m) => m.TestInviteePage,
);

// The active workspace resolves only for signed-in users, so WorkspaceProvider
// is mounted inside RequireAuth (never around the auth routes), wrapping the
// shell. AppLayout reads the active workspace name from useWorkspace().
// ChatProvider sits inside both SessionProvider and WorkspaceProvider (its
// connection hook reads useSession() and useWorkspace()) so the Agora chat
// connection now lives at the shell: it opens once per session and persists
// across route changes, tearing down only on signout or workspace switch.
// The three modules load as one lazy unit (in parallel, no waterfall).
const WorkspaceLayout = lazyRoute(
  () =>
    Promise.all([
      import('@/lib/workspace-context'),
      import('@/lib/chat'),
      import('@/components/shell/AppLayout'),
    ]),
  ([{ WorkspaceProvider }, { ChatProvider }, { AppLayout }]) =>
    function WorkspaceLayout(): ReactElement {
      useEffect(() => prefetchShellPages(), []);
      return (
        <WorkspaceProvider>
          <ChatProvider>
            <AppLayout />
          </ChatProvider>
        </WorkspaceProvider>
      );
    },
);

/** Once the signed-in shell is idle, warm the Pipeline and Chat chunks (code only, no data). */
function prefetchShellPages(): () => void {
  return whenIdle(() => {
    // A failed prefetch is harmless: the route's own lazy load retries and recovers.
    void loadPipeline().catch(() => undefined);
    void loadChat().catch(() => undefined);
  });
}

/** A plan opened beside Activity (Activity plan rows); Back falls back to /notifications. */
const notificationsPlan = page(<PlanPage fallback="/notifications" />);

/** The session loader doubles as the chunk fallback, so the swap never shifts layout. */
function page(element: ReactNode): ReactElement {
  return <Suspense fallback={<SessionLoading />}>{element}</Suspense>;
}

export default function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <TestSiteAnywhereStart />
        <Routes>
          <Route path="/" element={<HomeGate />} />
          <Route path="/auth/callback" element={page(<AuthCallbackPage />)} />
          <Route path="/legal/:policy" element={page(<LegalPolicyPage />)} />
          <Route path="/unsubscribe" element={page(<UnsubscribePage />)} />
          <Route element={<RequireGuest />}>
            <Route path="/signin" element={page(<SignInPage />)} />
            <Route path="/signup" element={page(<SignUpPage />)} />
          </Route>
          <Route element={<RequireAuth />}>
            <Route path="/invite/accept" element={page(<AcceptInvitePage />)} />
            <Route path="/invite/accept/:inviteId" element={page(<AcceptInvitePage />)} />
            <Route path="/test/invitee/:email" element={page(<TestInviteePage />)} />
            <Route element={page(<WorkspaceLayout />)}>
              <Route path="/pipeline" element={page(<PipelinePage />)} />
              <Route path="/posts/:postId" element={page(<PostDetailPage />)} />
              <Route path="/p/:ref" element={page(<PostRefResolver />)} />
              <Route path="/briefs" element={page(<BriefsPage />)} />
              <Route path="/briefs/:briefId" element={page(<BriefDetailPage />)} />
              <Route path="/b/:ref" element={page(<BriefRefResolver />)} />
              <Route path="/chat" element={page(<ChatPage />)} />
              {/* Notifications and a plan beside it share one layout: it never remounts. */}
              <Route
                element={page(
                  <PlanBesideLayout
                    page={page(<NotificationsPage />)}
                    planPattern="/plans/:planId"
                  />,
                )}
              >
                <Route path="/notifications" />
                <Route path="/plans/:planId" element={notificationsPlan} />
              </Route>
              <Route path="/activity" element={page(<ActivityRedirect />)} />
              {/* The Plan tab and a plan beside it: the calendar stays mounted. */}
              <Route
                element={page(
                  <PlanBesideLayout page={page(<PlanTabPage />)} planPattern="/plan/:planId" />,
                )}
              >
                <Route path="/plan" />
                <Route path="/plan/:planId" element={page(<PlanPage fallback="/plan" />)} />
              </Route>
              <Route path="/assets" element={page(<AssetsPage />)} />
              <Route path="/settings" element={page(<SettingsPage />)} />
              <Route path="/help" element={page(<HelpPage />)} />
              <Route path="/deleted" element={page(<RecentlyDeletedPage />)} />
              <Route path="*" element={<Navigate to="/pipeline" replace />} />
            </Route>
          </Route>
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  );
}
