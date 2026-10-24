// A compact single-choice dropdown matching the locked create-sheet look: an
// h-11 trigger (44px tap height) showing the selection with a chevron, opening a
// menu anchored to the button that flips upward when the button sits near the
// viewport bottom (e.g. a sheet footer) and downward otherwise. Pure,
// presentational, controlled: no data fetching lives here. The placement
// decision and the option rows are pure helpers so they unit-test without a DOM.

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement, ReactNode, RefObject } from 'react';
import { cn } from '@/lib/cn';
import { useEscapeLayer } from '@/lib/escape-stack';
import { IconCheck, IconChevronDown } from '@/components/ui/icons';

export interface SelectOption {
  value: string;
  label: string;
  /** Optional left slot: a colored bucket dot, an Avatar for owners. */
  renderLeft?: ReactNode;
}

export type MenuPlacement = 'up' | 'down';

/**
 * Decide whether the menu opens upward or downward. When the space below the
 * button (viewport height minus the button's bottom edge) is smaller than the
 * menu's estimated height the menu opens upward so it is not clipped by a sheet
 * footer; otherwise it opens downward. Pure so the open-direction behaviour is
 * unit-tested without a DOM.
 */
export function computeMenuPlacement(
  buttonBottom: number,
  viewportHeight: number,
  menuHeight = 260,
): MenuPlacement {
  return viewportHeight - buttonBottom < menuHeight ? 'up' : 'down';
}

/**
 * Build the option rows: each a >=44px row with an optional left slot and a
 * check tick on the selected row. Pure (no hooks) so render, selection and the
 * tick are unit-testable, mirroring SortMenu's sortOptionButtons.
 */
export function selectOptionRows(
  options: readonly SelectOption[],
  value: string,
  onPick: (value: string) => void,
): ReactElement[] {
  return options.map((option) => {
    const selected = option.value === value;
    return (
      <button
        key={option.value}
        type="button"
        role="option"
        aria-selected={selected}
        onClick={() => onPick(option.value)}
        className={cn(
          'flex min-h-[44px] w-full items-center gap-2.5 rounded-md px-3 text-left text-base transition-colors',
          selected ? 'text-fg' : 'text-fg-2 hover:bg-panel-2',
        )}
      >
        {option.renderLeft !== undefined ? (
          <span className="flex shrink-0 items-center">{option.renderLeft}</span>
        ) : null}
        <span className="min-w-0 flex-1 truncate">{option.label}</span>
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-accent">
          {selected ? <IconCheck size={16} /> : null}
        </span>
      </button>
    );
  });
}

interface SelectMenuProps {
  options: readonly SelectOption[];
  value: string;
  placement: MenuPlacement;
  onChange: (value: string) => void;
  onClose: () => void;
  /** The listbox element (the parent focuses the selected option on open). */
  listRef?: RefObject<HTMLDivElement>;
}

/** The keys the open listbox handles itself (the rest reach the page). */
const LISTBOX_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ']);

/**
 * Keyboard inside the open listbox: ArrowUp/Down move between options (no
 * wrap), Home/End jump to the ends, Enter or Space picks the focused option.
 * Escape is the parent's (the escape stack) and the panel's own handler.
 * Reads the options from the event's listbox, so it stays hook-free.
 */
export function onListboxKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
  if (!LISTBOX_KEYS.has(event.key) || typeof document === 'undefined') return;
  const list: HTMLDivElement | undefined = event.currentTarget;
  if (list === undefined) return;
  const rows = Array.from(list.querySelectorAll<HTMLElement>('[role="option"]'));
  if (rows.length === 0) return;
  const at = rows.findIndex((row) => row === document.activeElement);
  const last = rows.length - 1;
  let next: number | null = null;
  if (event.key === 'ArrowDown') next = Math.min(at + 1, last);
  else if (event.key === 'ArrowUp') next = at < 0 ? last : Math.max(at - 1, 0);
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = last;
  else if (at >= 0) {
    // Enter / Space: pick the focused option (one click, never the browser's own too).
    event.preventDefault();
    rows[at]?.click();
    return;
  }
  if (next === null) return;
  event.preventDefault();
  rows[next]?.focus();
}

/**
 * The open menu: a full-screen backdrop (outside click closes) plus the anchored
 * panel (Escape closes). Pure (no hooks) so both dismiss paths and selection are
 * unit-testable by reading the element tree directly.
 */
export function SelectMenu({
  options,
  value,
  placement,
  onChange,
  onClose,
  listRef,
}: SelectMenuProps): ReactElement {
  return (
    <>
      <div className="fixed inset-0 z-40" aria-hidden="true" onClick={onClose} />
      <div
        ref={listRef}
        role="listbox"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onClose();
            return;
          }
          onListboxKeyDown(event);
        }}
        className={cn(
          'absolute left-0 z-50 max-h-60 w-full min-w-0 overflow-y-auto rounded-xl border border-border-strong bg-panel p-1.5 shadow-2xl',
          placement === 'up' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
        )}
      >
        {selectOptionRows(options, value, (next) => {
          onChange(next);
          onClose();
        })}
      </div>
    </>
  );
}

interface SelectProps {
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Accessible label for the trigger. */
  label?: string;
  /** When set, a tap on the trigger calls this instead of opening the menu (the first post picks for the person). */
  onPress?: () => void;
}

export function Select({
  value,
  options,
  onChange,
  placeholder = 'Select',
  disabled = false,
  label,
  onPress,
}: SelectProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<MenuPlacement>('down');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = options.find((option) => option.value === value);

  // Escape closes only this popover while it is the top layer, never the sheet under it.
  useEscapeLayer(open, () => setOpen(false));

  // Open: focus the selected option (else the first) so the arrow keys work at
  // once. Close (a pick, Escape, outside tap): the trigger gets focus back.
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const trigger = buttonRef.current;
    const target =
      list?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ??
      list?.querySelector<HTMLElement>('[role="option"]') ??
      null;
    target?.focus({ preventScroll: true });
    return () => trigger?.focus({ preventScroll: true });
  }, [open]);

  function toggle(): void {
    if (disabled) return;
    if (onPress !== undefined) {
      onPress();
      return;
    }
    if (!open && buttonRef.current !== null && typeof window !== 'undefined') {
      const rect = buttonRef.current.getBoundingClientRect();
      setPlacement(computeMenuPlacement(rect.bottom, window.innerHeight));
    }
    setOpen((prev) => !prev);
  }

  return (
    <div className="relative min-w-0">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        {...(label !== undefined ? { 'aria-label': label } : {})}
        disabled={disabled}
        onClick={toggle}
        // 16px text below md so iOS Safari does not zoom on focus; 14px from md up.
        className="flex h-11 w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-panel-2 px-3 text-base md:text-base transition-colors hover:bg-panel-3 disabled:pointer-events-none disabled:opacity-50"
      >
        {selected?.renderLeft !== undefined ? (
          <span className="flex shrink-0 items-center">{selected.renderLeft}</span>
        ) : null}
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-left',
            selected !== undefined ? 'text-fg' : 'text-fg-3',
          )}
        >
          {selected?.label ?? placeholder}
        </span>
        <IconChevronDown size={16} className="shrink-0 text-fg-3" />
      </button>
      {open ? (
        <SelectMenu
          options={options}
          value={value}
          placement={placement}
          onChange={onChange}
          onClose={() => setOpen(false)}
          listRef={listRef}
        />
      ) : null}
    </div>
  );
}
