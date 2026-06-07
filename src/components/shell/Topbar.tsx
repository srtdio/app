import { useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { IconButton } from '@/components/ui/IconButton';
import { IconBriefs, IconPipeline, IconPlus, IconSearch } from '@/components/ui/icons';
import { MenuPopover } from '@/components/shell/MenuPopover';
import { MenuItem } from '@/components/shell/MenuItem';
import { dispatchSorted } from '@/lib/events';

interface TopbarProps {
  workspaceName: string;
  onOpenPalette: () => void;
  onOpenAvatar: () => void;
}

export function Topbar({ workspaceName, onOpenPalette, onOpenAvatar }: TopbarProps) {
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <header className="sticky top-0 z-30 flex items-center gap-2 h-14 px-3 md:px-4 border-b border-border bg-panel">
      <span className="md:hidden font-semibold text-sm truncate">{workspaceName}</span>

      <button
        type="button"
        onClick={onOpenPalette}
        className="hidden md:flex items-center gap-2 h-9 min-w-[240px] px-3 rounded-lg border border-border bg-panel-2 text-fg-3 text-sm hover:bg-panel-3 transition-colors"
      >
        <IconSearch size={16} />
        <span className="flex-1 text-left">Search</span>
        <kbd className="text-[11px] border border-border rounded px-1.5 py-0.5">⌘K</kbd>
      </button>

      <div className="ml-auto flex items-center gap-1">
        <IconButton label="Search" className="md:hidden" onClick={onOpenPalette}>
          <IconSearch />
        </IconButton>

        <div className="relative">
          <IconButton label="Create" onClick={() => setCreateOpen((value) => !value)}>
            <IconPlus />
          </IconButton>
          <MenuPopover open={createOpen} onClose={() => setCreateOpen(false)}>
            <MenuItem
              icon={<IconPipeline size={18} />}
              label="New post"
              onClick={() => {
                setCreateOpen(false);
                dispatchSorted('sorted:create-post');
              }}
            />
            <MenuItem
              icon={<IconBriefs size={18} />}
              label="New brief"
              onClick={() => {
                setCreateOpen(false);
                dispatchSorted('sorted:create-brief');
              }}
            />
          </MenuPopover>
        </div>

        <button
          type="button"
          aria-label="Account menu"
          onClick={onOpenAvatar}
          className="inline-flex items-center justify-center h-11 w-11 rounded-md hover:bg-panel-2 transition-colors"
        >
          <Avatar size="md" />
        </button>
      </div>
    </header>
  );
}
