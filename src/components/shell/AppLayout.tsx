import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from '@/components/shell/Sidebar';
import { BottomTabs } from '@/components/shell/BottomTabs';
import { Topbar } from '@/components/shell/Topbar';
import { CommandPalette } from '@/components/shell/CommandPalette';
import { AvatarMenu } from '@/components/shell/AvatarMenu';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconPipeline } from '@/components/ui/icons';
import { useWorkspace } from '@/lib/workspace-context';

export function AppLayout() {
  const { workspaceName, workspaces, loading } = useWorkspace();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);

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
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenAvatar={() => setAvatarOpen(true)}
        />
        <main className="flex-1 overflow-y-auto pb-[56px] md:pb-0">
          <Outlet />
        </main>
      </div>
      <BottomTabs />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <AvatarMenu open={avatarOpen} onClose={() => setAvatarOpen(false)} />
    </div>
  );
}
