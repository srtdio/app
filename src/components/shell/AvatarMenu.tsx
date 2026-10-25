import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sheet } from '@/components/ui/Sheet';
import { MenuItem } from '@/components/shell/MenuItem';
import {
  IconMoon,
  IconRotateCcw,
  IconScrollText,
  IconSettings,
  IconSignOut,
  IconSun,
  IconSwitch,
  IconTrash,
  ICON_SIZE,
} from '@/components/ui/icons';
import { useInduction } from '@/components/induction/InductionProvider';
import { dispatchSorted } from '@/lib/events';
import { GUIDE_CHROME } from '@/lib/induction-copy';
import { useTheme } from '@/lib/use-theme';
import { useIsLaptop } from '@/lib/use-is-laptop';
import { useDismissLayer } from '@/lib/modal-focus';

interface AvatarMenuProps {
  open: boolean;
  onClose: () => void;
}

export function AvatarMenu({ open, onClose }: AvatarMenuProps) {
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const isDesktop = useIsLaptop();
  const restartTour = useInduction()?.restart;
  // Laptop popover: Escape closes it and focus goes back to the account button
  // (the phone Sheet does both itself).
  const panelRef = useRef<HTMLDivElement>(null);
  useDismissLayer(open && isDesktop, onClose, panelRef);

  function go(to: string): void {
    onClose();
    navigate(to);
  }

  const rows = (
    <>
      <MenuItem
        icon={<IconSwitch size={ICON_SIZE.tray} />}
        label="Switch workspace"
        onClick={() => {
          onClose();
          dispatchSorted('sorted:switch-workspace');
        }}
      />
      <MenuItem
        icon={<IconSettings size={ICON_SIZE.tray} />}
        label="Settings"
        onClick={() => go('/settings')}
      />
      <MenuItem
        icon={<IconTrash size={ICON_SIZE.tray} />}
        label="Recently deleted"
        onClick={() => go('/deleted')}
      />
      <MenuItem
        icon={
          theme === 'dark' ? <IconSun size={ICON_SIZE.tray} /> : <IconMoon size={ICON_SIZE.tray} />
        }
        label="Appearance"
        onClick={toggle}
      />
      <MenuItem
        icon={<IconScrollText size={ICON_SIZE.tray} />}
        label="Help"
        onClick={() => go('/help')}
      />
      {restartTour !== undefined ? (
        <MenuItem
          icon={<IconRotateCcw size={ICON_SIZE.tray} />}
          label={GUIDE_CHROME.restart}
          onClick={() => {
            onClose();
            restartTour();
          }}
        />
      ) : null}
      <div className="my-1 h-px bg-border" />
      <MenuItem
        icon={<IconSignOut size={ICON_SIZE.tray} />}
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
          ref={panelRef}
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
