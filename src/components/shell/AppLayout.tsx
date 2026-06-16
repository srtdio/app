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
import { useWorkspace } from '@/lib/workspace-context';

export function AppLayout() {
  const { workspaceName, workspaces, loading, workspaceId, setActiveWorkspaceId } = useWorkspace();
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
