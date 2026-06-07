import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from '@/components/shell/AppLayout';
import { PipelinePage } from '@/components/pages/PipelinePage';
import { PostDetailPage } from '@/components/pages/PostDetailPage';
import { BriefsPage } from '@/components/pages/BriefsPage';
import { ChatPage } from '@/components/pages/ChatPage';
import { ActivityPage } from '@/components/pages/ActivityPage';
import { AssetsPage } from '@/components/pages/AssetsPage';
import { SettingsPage } from '@/components/pages/SettingsPage';
import { DeletedPage } from '@/components/pages/DeletedPage';
import { SignInPage } from '@/components/auth/SignInPage';
import { SignUpPage } from '@/components/auth/SignUpPage';
import { RequireAuth, RequireGuest } from '@/components/auth/RouteGuards';
import { SessionProvider } from '@/lib/session-context';
import { WorkspaceProvider } from '@/lib/workspace-context';

// The active workspace resolves only for signed-in users, so WorkspaceProvider
// is mounted inside RequireAuth (never around the auth routes), wrapping the
// shell. AppLayout reads the active workspace name from useWorkspace().
function WorkspaceLayout() {
  return (
    <WorkspaceProvider>
      <AppLayout />
    </WorkspaceProvider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <Routes>
          <Route element={<RequireGuest />}>
            <Route path="/signin" element={<SignInPage />} />
            <Route path="/signup" element={<SignUpPage />} />
          </Route>
          <Route element={<RequireAuth />}>
            <Route element={<WorkspaceLayout />}>
              <Route path="/" element={<Navigate to="/pipeline" replace />} />
              <Route path="/pipeline" element={<PipelinePage />} />
              <Route path="/posts/:postId" element={<PostDetailPage />} />
              <Route path="/briefs" element={<BriefsPage />} />
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
