import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from '@/components/shell/AppLayout';
import { ActivityRedirect } from '@/components/shell/ActivityRedirect';
import { PipelinePage } from '@/components/pages/PipelinePage';
import { PostDetailPage } from '@/components/pages/PostDetailPage';
import { BriefsPage } from '@/components/pages/BriefsPage';
import { BriefDetailPage } from '@/components/pages/BriefDetailPage';
import { ChatPage } from '@/components/pages/ChatPage';
import { AssetsPage } from '@/components/pages/AssetsPage';
import { RecentlyDeletedPage } from '@/components/pages/RecentlyDeletedPage';
import { SettingsPage } from '@/components/pages/SettingsPage';
import { HelpPage } from '@/components/pages/HelpPage';
import { NotificationsPage } from '@/components/pages/NotificationsPage';
import { PlanTabPage } from '@/components/pages/PlanTabPage';
import { PlanBesideLayout, PlanPage } from '@/components/pages/PlanPage';
import { SignInPage } from '@/components/auth/SignInPage';
import { AuthCallbackPage } from '@/components/auth/AuthCallbackPage';
import { LegalPolicyPage } from '@/components/auth/LegalPolicyPage';
import { UnsubscribePage } from '@/components/unsubscribe/UnsubscribePage';
import { SignUpPage } from '@/components/auth/SignUpPage';
import { AcceptInvitePage } from '@/components/auth/AcceptInvitePage';
import { TestInviteePage } from '@/components/test-site/TestInviteePage';
import { TestSiteAnywhereStart } from '@/components/test-site/TestSiteAnywhereStart';
import { PostRefResolver } from '@/components/refs/PostRefResolver';
import { BriefRefResolver } from '@/components/refs/BriefRefResolver';
import { RequireAuth, RequireGuest } from '@/components/auth/RouteGuards';
import { HomeGate } from '@/components/home/HomeGate';
import { SessionProvider } from '@/lib/session-context';
import { WorkspaceProvider } from '@/lib/workspace-context';
import { ChatProvider } from '@/lib/chat';

// The active workspace resolves only for signed-in users, so WorkspaceProvider
// is mounted inside RequireAuth (never around the auth routes), wrapping the
// shell. AppLayout reads the active workspace name from useWorkspace().
// ChatProvider sits inside both SessionProvider and WorkspaceProvider (its
// connection hook reads useSession() and useWorkspace()) so the Agora chat
// connection now lives at the shell: it opens once per session and persists
// across route changes, tearing down only on signout or workspace switch.
function WorkspaceLayout() {
  return (
    <WorkspaceProvider>
      <ChatProvider>
        <AppLayout />
      </ChatProvider>
    </WorkspaceProvider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <TestSiteAnywhereStart />
        <Routes>
          <Route path="/" element={<HomeGate />} />
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          <Route path="/legal/:policy" element={<LegalPolicyPage />} />
          <Route path="/unsubscribe" element={<UnsubscribePage />} />
          <Route element={<RequireGuest />}>
            <Route path="/signin" element={<SignInPage />} />
            <Route path="/signup" element={<SignUpPage />} />
          </Route>
          <Route element={<RequireAuth />}>
            <Route path="/invite/accept" element={<AcceptInvitePage />} />
            <Route path="/invite/accept/:inviteId" element={<AcceptInvitePage />} />
            <Route path="/test/invitee/:email" element={<TestInviteePage />} />
            <Route element={<WorkspaceLayout />}>
              <Route path="/pipeline" element={<PipelinePage />} />
              <Route path="/posts/:postId" element={<PostDetailPage />} />
              <Route path="/p/:ref" element={<PostRefResolver />} />
              <Route path="/briefs" element={<BriefsPage />} />
              <Route path="/briefs/:briefId" element={<BriefDetailPage />} />
              <Route path="/b/:ref" element={<BriefRefResolver />} />
              <Route path="/chat" element={<ChatPage />} />
              {/* Notifications and a plan beside it share one layout: it never remounts. */}
              <Route
                element={
                  <PlanBesideLayout page={<NotificationsPage />} planPattern="/plans/:planId" />
                }
              >
                <Route path="/notifications" />
                <Route path="/plans/:planId" element={<PlanPage fallback="/notifications" />} />
              </Route>
              <Route path="/activity" element={<ActivityRedirect />} />
              {/* The Plan tab and a plan beside it: the calendar stays mounted. */}
              <Route
                element={<PlanBesideLayout page={<PlanTabPage />} planPattern="/plan/:planId" />}
              >
                <Route path="/plan" />
                <Route path="/plan/:planId" element={<PlanPage fallback="/plan" />} />
              </Route>
              <Route path="/assets" element={<AssetsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/help" element={<HelpPage />} />
              <Route path="/deleted" element={<RecentlyDeletedPage />} />
              <Route path="*" element={<Navigate to="/pipeline" replace />} />
            </Route>
          </Route>
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  );
}
