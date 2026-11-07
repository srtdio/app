import { useRef, useState } from 'react';
import { userDensitySet } from '@srtdio/rpc';
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
import { useMenuKeys } from '@/lib/useMenuKeys';
import { Chip } from '@/components/ui/Chip';
import { Button } from '@/components/ui/Button';
import { ErrorNote } from '@/components/ui/ErrorNote';
import { Text } from '@/components/ui/Text';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';
import { logger } from '@/lib/logger';
import { getProfileSnapshot } from '@/lib/use-current-profile';
import {
  activeDensity,
  revertDensity,
  setDensityLocal,
  DENSITIES,
  type Density,
} from '@/lib/density';

/** The density picks, in order (decided 8 Nov 2026; Cozy is the default). */
export const DENSITY_LABEL: Record<Density, string> = {
  compact: 'Compact',
  cozy: 'Cozy',
  calm: 'Calm',
};

/** The save failed: reverted, with a Retry (Words: "Couldn't {action}."). */
export const DENSITY_SAVE_FAILED = "Couldn't save density.";

/**
 * Density under Appearance: label, then three tap chips in a 3-column grid.
 * A tap applies at once (html attribute + device cache, no await) and saves
 * fire-and-forget through user_density_set; a failed save reverts and shows
 * the ErrorNote with Retry. The menu stays open.
 */
export function DensityRow() {
  const [density, setDensity] = useState<Density>(() => activeDensity());
  const [failed, setFailed] = useState<Density | null>(null);

  function pick(next: Density): void {
    const userId = getProfileSnapshot().userId;
    const previous = setDensityLocal(userId, next);
    setDensity(next);
    setFailed(null);
    if (next === previous) return;
    const revert = (): void => {
      // Only undo when this pick is still the one on screen.
      if (activeDensity() !== next) return;
      revertDensity(userId, previous);
      setDensity(previous);
      setFailed(next);
    };
    void userDensitySet(supabase, { p_density: next, p_trace_id: generateTraceId() }).then(
      (result) => {
        if (result.ok) return;
        logger.error('user_density_set failed', { error: result.error.message });
        revert();
      },
      (thrown: unknown) => {
        logger.error('user_density_set failed', { error: String(thrown) });
        revert();
      },
    );
  }

  return (
    <div data-density-row="" className="flex flex-col gap-2 px-3 py-2">
      <Text role="label" className="text-fg-2">
        Density
      </Text>
      <div role="radiogroup" aria-label="Density" className="grid grid-cols-3 gap-2">
        {DENSITIES.map((d) => (
          <Chip
            key={d}
            size="tap"
            label={DENSITY_LABEL[d]}
            selected={density === d}
            role="radio"
            aria-checked={density === d}
            aria-pressed={undefined}
            data-density-pick={d}
            className="w-full"
            onClick={() => pick(d)}
          />
        ))}
      </div>
      {failed !== null ? (
        <ErrorNote className="flex items-center justify-between gap-2">
          <span>{DENSITY_SAVE_FAILED}</span>
          <Button type="button" variant="ghost" onClick={() => pick(failed)}>
            Retry
          </Button>
        </ErrorNote>
      ) : null}
    </div>
  );
}

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
  // First item takes focus on open; the arrows move between items.
  const keys = useMenuKeys(panelRef, open && isDesktop);

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
      <DensityRow />
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
        <div className="fixed inset-0 z-dock" aria-hidden="true" onClick={onClose} />
        <div
          ref={panelRef}
          role="menu"
          aria-label="Account"
          onKeyDown={keys.onKeyDown}
          className="fixed top-14 right-3 z-sheet w-72 rounded-xl border bg-panel p-1 lit-overlay"
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
