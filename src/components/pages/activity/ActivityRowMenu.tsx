import { useState } from 'react';
import type { MouseEvent, ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { Sheet } from '@/components/ui/Sheet';
import { IconCheck, IconClock, IconMore } from '@/components/ui/icons';
import { useMediaQuery } from '@/lib/use-media-query';
import { SNOOZE_OPTIONS, type SnoozeKind } from '@/components/pages/activity/data';

interface ActivityRowMenuProps {
  /** True when the row is currently snoozed (offers Clear instead of nothing). */
  snoozed: boolean;
  /** True when the row is unread (offers Mark as read). */
  unread: boolean;
  onSnooze: (kind: SnoozeKind) => void;
  onMarkRead: () => void;
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
  const isDesktop = useMediaQuery('(min-width: 768px)');

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
    <button
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label="Activity options"
      onClick={(event) => {
        isolate(event);
        setOpen((prev) => !prev);
      }}
      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-panel-2 hover:text-fg"
    >
      <IconMore size={18} />
    </button>
  );

  const item = (
    key: string,
    label: string,
    icon: ReactElement,
    onClick: () => void,
  ): ReactElement => (
    <button
      key={key}
      type="button"
      role="menuitem"
      onClick={(event) => {
        isolate(event);
        onClick();
      }}
      className="flex min-h-[44px] w-full items-center gap-2.5 rounded-md px-3 text-left text-sm text-fg-2 transition-colors hover:bg-panel-2 hover:text-fg"
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-fg-3">{icon}</span>
      <span className="flex-1">{label}</span>
    </button>
  );

  const list = (
    <div role="menu" aria-label="Activity options" className="flex flex-col">
      {unread ? item('mark-read', 'Mark as read', <IconCheck size={16} />, pickMarkRead) : null}
      {SNOOZE_OPTIONS.map((option) =>
        item(option.kind, `Snooze ${option.label}`, <IconClock size={16} />, () =>
          pickSnooze(option.kind),
        ),
      )}
      {snoozed
        ? item('clear', 'Un-snooze', <IconClock size={16} />, () => pickSnooze('clear'))
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
