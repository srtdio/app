import { useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { IconBell, IconCheck, IconChevronRight, IconKebab, IconMoon } from '@/components/ui/icons';
import { useMediaQuery } from '@/lib/use-media-query';
import { isCurrentlySnoozed } from './digest';
import type { ActivityItem } from './types';

export type SnoozeKind = '1h' | '4h' | 'tomorrow_9' | 'next_week';

interface ActivityRowMenuProps {
  item: ActivityItem;
  nowMs: number;
  onMarkRead: () => void;
  onSnooze: (kind: SnoozeKind) => void;
  onUnsnooze: () => void;
  onOpen: () => void;
}

interface MenuAction {
  key: string;
  label: string;
  icon: ReactNode;
  run: () => void;
}

/**
 * Build the menu's actions from the item's state. Pure (no hooks) so the same
 * rows render in the desktop popover and the mobile sheet: snoozed entries get
 * Unsnooze + Open; live entries get Mark as read (when unread), the four snooze
 * presets, and Open.
 */
export function rowMenuActions(props: ActivityRowMenuProps): MenuAction[] {
  if (isCurrentlySnoozed(props.item, props.nowMs)) {
    return [
      { key: 'unsnooze', label: 'Unsnooze', icon: <IconBell size={16} />, run: props.onUnsnooze },
      { key: 'open', label: 'Open', icon: <IconChevronRight size={16} />, run: props.onOpen },
    ];
  }
  const actions: MenuAction[] = [];
  if (props.item.readAt === null) {
    actions.push({
      key: 'read',
      label: 'Mark as read',
      icon: <IconCheck size={16} />,
      run: props.onMarkRead,
    });
  }
  actions.push(
    {
      key: '1h',
      label: 'Snooze 1 hour',
      icon: <IconMoon size={16} />,
      run: () => props.onSnooze('1h'),
    },
    {
      key: '4h',
      label: 'Snooze 4 hours',
      icon: <IconMoon size={16} />,
      run: () => props.onSnooze('4h'),
    },
    {
      key: 'tomorrow_9',
      label: 'Snooze until tomorrow 9:00',
      icon: <IconMoon size={16} />,
      run: () => props.onSnooze('tomorrow_9'),
    },
    {
      key: 'next_week',
      label: 'Snooze until next week',
      icon: <IconMoon size={16} />,
      run: () => props.onSnooze('next_week'),
    },
    { key: 'open', label: 'Open', icon: <IconChevronRight size={16} />, run: props.onOpen },
  );
  return actions;
}

function actionButtons(actions: MenuAction[], onPick: (run: () => void) => void): ReactElement[] {
  return actions.map((action) => (
    <button
      key={action.key}
      type="button"
      role="menuitem"
      onClick={() => onPick(action.run)}
      className="flex min-h-[44px] items-center gap-2.5 rounded-md px-3 text-left text-sm text-fg-2 transition-colors hover:bg-panel-2 hover:text-fg md:min-h-0 md:h-9"
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-fg-3">
        {action.icon}
      </span>
      <span className="flex-1">{action.label}</span>
    </button>
  ));
}

// Per-entry kebab. Structure mirrors SortMenu exactly: desktop is an inline
// popover under the trigger with a fixed inset-0 backdrop; mobile is a Sheet.
export function ActivityRowMenu(props: ActivityRowMenuProps) {
  const [open, setOpen] = useState(false);
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const actions = rowMenuActions(props);

  function pick(run: () => void): void {
    run();
    setOpen(false);
  }

  const trigger = (
    <button
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label="Activity actions"
      onClick={() => setOpen((prev) => !prev)}
      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-fg-2 transition-colors hover:bg-panel-2 hover:text-fg"
    >
      <IconKebab size={18} />
    </button>
  );

  const list = (
    <div role="menu" aria-label="Activity actions" className="flex flex-col">
      {actionButtons(actions, pick)}
    </div>
  );

  if (isDesktop) {
    return (
      <div className="relative">
        {trigger}
        {open ? (
          <>
            <div className="fixed inset-0 z-40" aria-hidden="true" onClick={() => setOpen(false)} />
            <div className="absolute right-0 top-full z-50 mt-1.5 w-56 rounded-xl border border-border-strong bg-panel p-1.5 shadow-2xl">
              {list}
            </div>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <>
      {trigger}
      <Sheet open={open} onClose={() => setOpen(false)} title="Activity actions">
        {list}
      </Sheet>
    </>
  );
}
