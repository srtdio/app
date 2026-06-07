import { useNavigate } from 'react-router-dom';
import { Sheet } from '@/components/ui/Sheet';
import { MenuItem } from '@/components/shell/MenuItem';
import {
  IconMoon,
  IconSettings,
  IconSignOut,
  IconSun,
  IconSwitch,
  IconTrash,
  IconUser,
} from '@/components/ui/icons';
import { dispatchSorted } from '@/lib/events';
import { useTheme } from '@/lib/use-theme';
import { useMediaQuery } from '@/lib/use-media-query';

interface AvatarMenuProps {
  open: boolean;
  onClose: () => void;
}

export function AvatarMenu({ open, onClose }: AvatarMenuProps) {
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const isDesktop = useMediaQuery('(min-width: 768px)');

  function go(to: string): void {
    onClose();
    navigate(to);
  }

  const rows = (
    <>
      <MenuItem
        icon={<IconSwitch size={18} />}
        label="Switch workspace"
        onClick={() => {
          onClose();
          dispatchSorted('sorted:switch-workspace');
        }}
      />
      <MenuItem icon={<IconSettings size={18} />} label="Settings" onClick={() => go('/settings')} />
      <MenuItem
        icon={<IconTrash size={18} />}
        label="Recently deleted"
        onClick={() => go('/deleted')}
      />
      <MenuItem
        icon={<IconUser size={18} />}
        label="Profile"
        onClick={() => go('/settings?panel=profile')}
      />
      <MenuItem
        icon={theme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
        label="Appearance"
        onClick={toggle}
      />
      <div className="my-1 h-px bg-border" />
      <MenuItem
        icon={<IconSignOut size={18} />}
        label="Sign out"
        onClick={() => {
          onClose();
          dispatchSorted('sorted:signout');
        }}
      />
    </>
  );

  if (!open) {
    return null;
  }

  if (isDesktop) {
    return (
      <>
        <div className="fixed inset-0 z-40" aria-hidden="true" onClick={onClose} />
        <div
          role="menu"
          className="fixed top-[56px] right-3 z-50 w-[244px] rounded-xl border border-border-strong bg-panel p-1.5 shadow-2xl"
        >
          {rows}
        </div>
      </>
    );
  }

  return (
    <Sheet open={open} onClose={onClose} title="Menu">
      {rows}
    </Sheet>
  );
}
