import { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { IconButton } from '@/components/ui/IconButton';
import { Sheet } from '@/components/ui/Sheet';
import { IconCheck, IconSort, ICON_SIZE } from '@/components/ui/icons';
import { useDismissLayer } from '@/lib/modal-focus';
import { useIsLaptop } from '@/lib/use-is-laptop';

export interface SortOption<T extends string = string> {
  value: T;
  label: string;
}

/**
 * Build the option buttons for the menu. Pure (no hooks) so it renders the same
 * rows in the desktop popover and the mobile sheet, and so the render/active/
 * onChange behaviour is unit-testable without a DOM. The active option carries a
 * checkmark and aria-checked.
 */
export function sortOptionButtons<T extends string>(
  options: SortOption<T>[],
  value: T,
  onPick: (value: T) => void,
): ReactElement[] {
  return options.map((option) => {
    const selected = option.value === value;
    return (
      <button
        key={option.value}
        type="button"
        role="menuitemradio"
        aria-checked={selected}
        onClick={() => onPick(option.value)}
        className={cn(
          'flex min-h-[44px] items-center gap-2.5 rounded-lg px-3 text-left text-base transition-colors',
          selected ? 'text-fg' : 'text-fg-2 hover:bg-panel-2',
        )}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-accent">
          {selected ? <IconCheck size={ICON_SIZE.inline} /> : null}
        </span>
        <span className="flex-1">{option.label}</span>
      </button>
    );
  });
}

interface SortMenuProps<T extends string> {
  options: SortOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible label for the trigger and menu. Defaults to "Sort". */
  label?: string;
}

// Canonical sort control: one IconButton (sort icon, label, no chevron), the
// list-toolbar rule. Generic over the option value so every page
// (Assets first, then Pipeline/Briefs/Activity) reuses it without hardcoding.
// Desktop = popover anchored under the trigger; mobile = bottom Sheet. The
// active option carries a checkmark and aria-checked.
export function SortMenu<T extends string>({
  options,
  value,
  onChange,
  label = 'Sort',
}: SortMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const isDesktop = useIsLaptop();
  // Desktop popover: Escape closes it and focus goes back to the trigger (the
  // phone Sheet does both itself).
  const panelRef = useRef<HTMLDivElement>(null);
  useDismissLayer(open && isDesktop, () => setOpen(false), panelRef);

  function choose(next: T): void {
    onChange(next);
    setOpen(false);
  }

  const trigger = (
    <IconButton
      type="button"
      label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => setOpen((prev) => !prev)}
      className="shrink-0"
    >
      <IconSort size={ICON_SIZE.control} />
    </IconButton>
  );

  const list = (
    <div role="menu" aria-label={label} className="flex flex-col">
      {sortOptionButtons(options, value, choose)}
    </div>
  );

  if (isDesktop) {
    return (
      <div className="relative">
        {trigger}
        {open ? (
          <>
            <div className="fixed inset-0 z-40" aria-hidden="true" onClick={() => setOpen(false)} />
            <div
              ref={panelRef}
              className="absolute right-0 top-full z-50 mt-1.5 w-44 rounded-xl border border-border-strong bg-panel p-1.5 shadow-2xl"
            >
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
      <Sheet open={open} onClose={() => setOpen(false)} title={label}>
        {list}
      </Sheet>
    </>
  );
}
