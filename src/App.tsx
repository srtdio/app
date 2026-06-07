import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from '@/components/shell/AppLayout';
import { PipelinePage } from '@/components/pages/PipelinePage';
import { BriefsPage } from '@/components/pages/BriefsPage';
import { ChatPage } from '@/components/pages/ChatPage';
import { ActivityPage } from '@/components/pages/ActivityPage';
import { AssetsPage } from '@/components/pages/AssetsPage';
import { SettingsPage } from '@/components/pages/SettingsPage';
import { DeletedPage } from '@/components/pages/DeletedPage';

// Placeholder until the active workspace comes from auth/session in a later PR.
// Passed as a prop so no surface hardcodes a workspace name.
const WORKSPACE_NAME = 'Workspace';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout workspaceName={WORKSPACE_NAME} />}>
          <Route path="/" element={<Navigate to="/pipeline" replace />} />
          <Route path="/pipeline" element={<PipelinePage />} />
          <Route path="/briefs" element={<BriefsPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/assets" element={<AssetsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/deleted" element={<DeletedPage />} />
          <Route path="*" element={<Navigate to="/pipeline" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
