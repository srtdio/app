import { useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { MenuPopover } from '@/components/shell/MenuPopover';
import { IconButton } from '@/components/ui/IconButton';
import { PressableRow } from '@/components/ui/PressableRow';
import { Sheet } from '@/components/ui/Sheet';
import { ICON_SIZE, IconMore } from '@/components/ui/icons';
import type { IconProps } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { useIsLaptop } from '@/lib/use-is-laptop';

/** One row of a ⋯ menu. */
export interface ActionMenuItem {
  id: string;
  label: string;
  /** An icon from ui/icons.tsx; the menu sets its size (tray on phone, inline on laptop). */
  icon: ComponentType<IconProps>;
  /** One meta line under the label, phone only. */
  description?: string;
  tone?: 'danger';
  onSelect: () => void;
}

interface ActionMenuProps {
  /** The phone sheet's title, and the menu's accessible name. */
  title: string;
  items: readonly ActionMenuItem[];
  /**
   * The opener. Default: IconButton IconMore "More actions". Pass null for a
   * menu opened only by the caller (long press, row tap) through `open`.
   */
  trigger?: ReactNode | null;
  /** Controlled open state; omit to let the trigger toggle it. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Content above the rows (MessageActionMenu's emoji row). */
  header?: ReactNode;
  /** Laptop popover edge; default right (the header's top-right trigger). */
  align?: 'left' | 'right';
}

// Rank of a row in the one order every ⋯ menu follows: Open first, Copy link
// second, the rest in the caller's order, Delete last.
function rank(item: ActionMenuItem): number {
  if (item.id === 'open' || item.id.startsWith('open-') || item.label.startsWith('Open')) return 0;
  if (item.id === 'copy-link' || item.label === 'Copy link') return 1;
  if (item.id === 'delete' || item.id.startsWith('delete') || item.label.startsWith('Delete')) {
    return 3;
  }
  return 2;
}

/** The rows in menu order: Open, Copy link, others (caller order), Delete last. Pure, stable. */
export function orderActionItems(items: readonly ActionMenuItem[]): ActionMenuItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map(({ item }) => item);
}

/**
 * The one ⋯ menu. Phone: a Sheet titled {title} of PressableRows (tray-size
 * icon, optional one-line description). Laptop (useIsLaptop): a MenuPopover
 * anchored to the trigger with the same rows, no descriptions. A row closes
 * the menu, then runs its onSelect.
 */
export function ActionMenu({
  title,
  items,
  trigger,
  open: openProp,
  onOpenChange,
  header,
  align = 'right',
}: ActionMenuProps) {
  const isLaptop = useIsLaptop();
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;

  function setOpen(next: boolean): void {
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  }

  const rows = orderActionItems(items);

  function select(item: ActionMenuItem): void {
    setOpen(false);
    item.onSelect();
  }

  const opener =
    trigger === null ? null : (
      <span className="inline-flex" onClick={() => setOpen(!open)}>
        {trigger ?? (
          <IconButton label="More actions" aria-haspopup="menu" aria-expanded={open}>
            <IconMore size={ICON_SIZE.control} />
          </IconButton>
        )}
      </span>
    );

  if (isLaptop) {
    return (
      <span className="relative inline-flex">
        {opener}
        <MenuPopover open={open} onClose={() => setOpen(false)} align={align}>
          <div aria-label={title}>
            {header}
            {rows.map((item) => {
              const Icon = item.icon;
              return (
                <PressableRow
                  key={item.id}
                  role="menuitem"
                  onClick={() => select(item)}
                  className={cn(
                    'flex items-center gap-3 px-3 text-base transition-colors',
                    item.tone === 'danger' ? 'text-bad' : 'text-fg',
                  )}
                >
                  <span
                    className={cn('shrink-0', item.tone === 'danger' ? 'text-bad' : 'text-fg-2')}
                  >
                    <Icon size={ICON_SIZE.inline} />
                  </span>
                  <span className="truncate">{item.label}</span>
                </PressableRow>
              );
            })}
          </div>
        </MenuPopover>
      </span>
    );
  }

  return (
    <>
      {opener}
      <Sheet open={open} onClose={() => setOpen(false)} title={title}>
        {header}
        <div role="menu" aria-label={title} className="flex flex-col">
          {rows.map((item) => {
            const Icon = item.icon;
            return (
              <PressableRow
                key={item.id}
                role="menuitem"
                onClick={() => select(item)}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 transition-colors',
                  item.tone === 'danger' ? 'text-bad' : 'text-fg',
                )}
              >
                <span
                  className={cn(
                    'flex shrink-0 items-center justify-center',
                    item.tone === 'danger' ? 'text-bad' : 'text-fg-2',
                  )}
                >
                  <Icon size={ICON_SIZE.tray} />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-base font-medium leading-snug">{item.label}</span>
                  {item.description !== undefined ? (
                    <span className="truncate text-sm leading-snug text-fg-3">
                      {item.description}
                    </span>
                  ) : null}
                </span>
              </PressableRow>
            );
          })}
        </div>
      </Sheet>
    </>
  );
}
