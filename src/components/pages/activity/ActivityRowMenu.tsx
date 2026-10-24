import { useEffect, useState } from 'react';
import type { MouseEvent, ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { Sheet } from '@/components/ui/Sheet';
import { PressableRow } from '@/components/ui/PressableRow';
import { IconButton } from '@/components/ui/IconButton';
import { ICON_SIZE, IconCheck, IconClock, IconMore } from '@/components/ui/icons';
import { LAPTOP_QUERY } from '@/lib/use-media-query';
import { SNOOZE_OPTIONS, type SnoozeKind } from '@/components/pages/activity/data';

interface ActivityRowMenuProps {
  /** True when the row is currently snoozed (offers Clear instead of nothing). */
  snoozed: boolean;
  /** True when the row is unread (offers Mark as read). */
  unread: boolean;
  onSnooze: (kind: SnoozeKind) => void;
  onMarkRead: () => void;
}

/**
 * The laptop query, safe where there is no window (a server render, the node
 * unit env): it reads as laptop there, which renders the plain popover markup.
 * Every card mounts this menu, so a card render never touches matchMedia first.
 */
function useLaptop(): boolean {
  const [laptop, setLaptop] = useState<boolean>(() =>
    typeof window === 'undefined' || typeof window.matchMedia !== 'function'
      ? true
      : window.matchMedia(LAPTOP_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(LAPTOP_QUERY);
    const onChange = (): void => setLaptop(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, []);
  return laptop;
}

/** Stop a click from bubbling to the card (navigate / mark-read) underneath. */
function isolate(event: MouseEvent): void {
  event.stopPropagation();
}

/**
 * The per-row kebab. Trigger, popover (desktop) / Sheet (mobile), and every menu
 * item stop propagation so interacting with the menu never triggers the card's
 * navigate or mark-read. Offers snooze (and Clear when snoozed) plus Mark as read
 * for an unread row.
 */
export function ActivityRowMenu({ snoozed, unread, onSnooze, onMarkRead }: ActivityRowMenuProps) {
  const [open, setOpen] = useState(false);
  const isDesktop = useLaptop();

  function close(): void {
    setOpen(false);
  }

  function pickSnooze(kind: SnoozeKind): void {
    onSnooze(kind);
    close();
  }

  function pickMarkRead(): void {
    onMarkRead();
    close();
  }

  const trigger = (
    <IconButton
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      label="Activity options"
      onClick={(event) => {
        isolate(event);
        setOpen((prev) => !prev);
      }}
      // text-fg-3 sorts after IconButton's text-fg-2, so it wins without an override.
      className="text-fg-3 shrink-0"
    >
      <IconMore size={ICON_SIZE.control} />
    </IconButton>
  );

  const item = (
    key: string,
    label: string,
    icon: ReactElement,
    onClick: () => void,
  ): ReactElement => (
    <PressableRow
      key={key}
      type="button"
      role="menuitem"
      onClick={(event) => {
        isolate(event);
        onClick();
      }}
      className="flex items-center gap-2.5 px-4 text-base font-medium text-fg-2 transition-colors duration-fast hover:text-fg"
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-fg-3">{icon}</span>
      <span className="flex-1">{label}</span>
    </PressableRow>
  );

  const list = (
    <div role="menu" aria-label="Activity options" className="flex flex-col">
      {unread
        ? item('mark-read', 'Mark as read', <IconCheck size={ICON_SIZE.inline} />, pickMarkRead)
        : null}
      <p className="px-3 pb-1 pt-2 text-sm font-semibold uppercase tracking-[0.06em] text-fg-2">
        Snooze
      </p>
      {SNOOZE_OPTIONS.map((option) =>
        item(option.kind, option.label, <IconClock size={ICON_SIZE.inline} />, () =>
          pickSnooze(option.kind),
        ),
      )}
      {snoozed
        ? item('clear', 'Un-snooze', <IconClock size={ICON_SIZE.inline} />, () =>
            pickSnooze('clear'),
          )
        : null}
    </div>
  );

  if (isDesktop) {
    return (
      <div className="relative" onClick={isolate}>
        {trigger}
        {open ? (
          <>
            <div className="fixed inset-0 z-40" aria-hidden="true" onClick={close} />
            <div
              className={cn(
                'absolute right-0 top-full z-50 mt-1.5 w-52 rounded-xl border',
                'border-border-strong bg-panel p-1.5 shadow-2xl',
              )}
            >
              {list}
            </div>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div onClick={isolate}>
      {trigger}
      <Sheet open={open} onClose={close} title="Activity options">
        {list}
      </Sheet>
    </div>
  );
}
