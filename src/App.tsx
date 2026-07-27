import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from '@/components/shell/AppLayout';
import { PipelinePage } from '@/components/pages/PipelinePage';
import { PostDetailPage } from '@/components/pages/PostDetailPage';
import { BriefsPage } from '@/components/pages/BriefsPage';
import { BriefDetailPage } from '@/components/pages/BriefDetailPage';
import { ChatPage } from '@/components/pages/ChatPage';
import { ActivityPage } from '@/components/pages/ActivityPage';
import { AssetsPage } from '@/components/pages/AssetsPage';
import { SettingsPage } from '@/components/pages/SettingsPage';
import { DeletedPage } from '@/components/pages/DeletedPage';
import { SignInPage } from '@/components/auth/SignInPage';
import { AuthCallbackPage } from '@/components/auth/AuthCallbackPage';
import { SignUpPage } from '@/components/auth/SignUpPage';
import { AcceptInvitePage } from '@/components/auth/AcceptInvitePage';
import { PostRefResolver } from '@/components/refs/PostRefResolver';
import { BriefRefResolver } from '@/components/refs/BriefRefResolver';
import { RequireAuth, RequireGuest } from '@/components/auth/RouteGuards';
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
        <Routes>
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          <Route element={<RequireGuest />}>
            <Route path="/signin" element={<SignInPage />} />
            <Route path="/signup" element={<SignUpPage />} />
          </Route>
          <Route element={<RequireAuth />}>
            <Route path="/invite/accept" element={<AcceptInvitePage />} />
            <Route path="/invite/accept/:inviteId" element={<AcceptInvitePage />} />
            <Route element={<WorkspaceLayout />}>
              <Route path="/" element={<Navigate to="/pipeline" replace />} />
              <Route path="/pipeline" element={<PipelinePage />} />
              <Route path="/posts/:postId" element={<PostDetailPage />} />
              <Route path="/p/:ref" element={<PostRefResolver />} />
              <Route path="/briefs" element={<BriefsPage />} />
              <Route path="/briefs/:briefId" element={<BriefDetailPage />} />
              <Route path="/b/:ref" element={<BriefRefResolver />} />
              <Route path="/chat" element={<ChatPage />} />
              <Route path="/activity" element={<ActivityPage />} />
              <Route path="/assets" element={<AssetsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/deleted" element={<DeletedPage />} />
              <Route path="*" element={<Navigate to="/pipeline" replace />} />
            </Route>
          </Route>
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  );
}
