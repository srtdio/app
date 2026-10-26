import { useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, ComponentType, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MenuPopover } from '@/components/shell/MenuPopover';
import { IconButton } from '@/components/ui/IconButton';
import { PressableRow } from '@/components/ui/PressableRow';
import { Sheet } from '@/components/ui/Sheet';
import { ICON_SIZE, IconMore } from '@/components/ui/icons';
import type { IconProps } from '@/components/ui/icons';
import { moveMenuFocus } from '@/lib/chat/menu-keys';
import { cn } from '@/lib/cn';
import { useIsLaptop, viewportSize } from '@/lib/use-is-laptop';

/** One row of a ⋯ menu. */
export interface ActionMenuItem {
  id: string;
  label: string;
  /** An icon from ui/icons.tsx; the menu sets its size (ICON_SIZE.tray, phone and laptop). */
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

/**
 * The ⋯ opener: IconButton IconMore, label "More actions" by default. ActionMenu
 * renders it as its default trigger; a host whose menu lives elsewhere in the
 * tree (an embedded page's `trigger={null}` menu) renders it and opens that menu
 * through `open`, so IconMore never appears outside ActionMenu.
 */
export function ActionMenuTrigger({
  label = 'More actions',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label?: string }) {
  return (
    <IconButton label={label} aria-haspopup="menu" {...props}>
      <IconMore size={ICON_SIZE.control} />
    </IconButton>
  );
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

// Laptop popover geometry: MenuPopover's row height, its p-1.5 padding plus
// border, its mt-2 gap, its min width, and the margin kept from the viewport.
const ROW_PX = 44;
const PANEL_CHROME_PX = 14;
const GAP_PX = 8;
const MENU_MIN_W_PX = 220;
const EDGE_PX = 8;

interface Anchor {
  style: CSSProperties;
  align: 'left' | 'right';
}

/**
 * Where the laptop popover goes: a zero-height fixed box spanning the trigger,
 * under it when the rows fit below, else lifted so the menu ends above it; the
 * edge flips when the preferred one would run off the viewport. Pure.
 */
function popoverAnchor(
  rect: { top: number; bottom: number; left: number; right: number },
  rows: number,
  viewport: { width: number; height: number },
  preferred: 'left' | 'right',
): Anchor {
  const menuH = rows * ROW_PX + PANEL_CHROME_PX;
  const below = rect.bottom + GAP_PX + menuH + EDGE_PX <= viewport.height;
  const top = below ? rect.bottom : Math.max(EDGE_PX - GAP_PX, rect.top - menuH - 2 * GAP_PX);
  let align = preferred;
  if (align === 'right' && rect.right - MENU_MIN_W_PX < EDGE_PX) align = 'left';
  else if (align === 'left' && rect.left + MENU_MIN_W_PX > viewport.width - EDGE_PX) {
    align = 'right';
  }
  return {
    align,
    style: { position: 'fixed', top, left: rect.left, width: rect.right - rect.left, height: 0 },
  };
}

/**
 * The one ⋯ menu. Phone: a Sheet titled {title} of PressableRows (tray-size
 * icon, optional one-line description). Laptop (useIsLaptop): a MenuPopover
 * anchored to the trigger with the same rows (tray-size icon), no
 * descriptions. Both close on Escape and hand focus back to the opener. A row
 * closes the menu, then runs its onSelect.
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
  const wrapRef = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  // Laptop: measure the trigger on open and portal the popover to the body, so
  // a scrolling or overflow-hidden parent (a board column, a list) never clips
  // it. Scroll or resize closes it rather than leaving it behind.
  useEffect(() => {
    // Closing keeps the last anchor so MenuPopover plays its exit fade.
    if (!isLaptop) setAnchor(null);
    if (!isLaptop || !open) return;
    const el = wrapRef.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    setAnchor(popoverAnchor(r, rows.length, viewportSize(), align));
    function close(): void {
      setOpen(false);
    }
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-measure on open only
  }, [isLaptop, open]);

  function select(item: ActionMenuItem): void {
    setOpen(false);
    item.onSelect();
  }

  const opener =
    trigger === null ? null : (
      <span className="inline-flex" onClick={() => setOpen(!open)}>
        {trigger ?? <ActionMenuTrigger aria-expanded={open} />}
      </span>
    );

  if (isLaptop) {
    return (
      <span ref={wrapRef} className="inline-flex">
        {opener}
        {anchor !== null
          ? createPortal(
              <div className="z-50" style={anchor.style}>
                <MenuPopover open={open} onClose={() => setOpen(false)} align={anchor.align}>
                  <div
                    aria-label={title}
                    onKeyDown={(event) => {
                      // A popover menu (no aria-modal): arrow keys, Home and End move between rows.
                      if (moveMenuFocus(event.currentTarget, event.key)) event.preventDefault();
                    }}
                  >
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
                            className={cn(
                              'shrink-0',
                              item.tone === 'danger' ? 'text-bad' : 'text-fg-2',
                            )}
                          >
                            <Icon size={ICON_SIZE.tray} />
                          </span>
                          <span className="truncate">{item.label}</span>
                        </PressableRow>
                      );
                    })}
                  </div>
                </MenuPopover>
              </div>,
              document.body,
            )
          : null}
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
