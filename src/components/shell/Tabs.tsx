import { useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { PressableRow } from '@/components/ui/PressableRow';
import { cn } from '@/lib/cn';

export interface TabItem {
  key: string;
  label: string;
}

interface TabsProps {
  items: TabItem[];
  active: string;
  onChange: (key: string) => void;
  /** Names the tab row for screen readers (e.g. "Settings"). */
  label?: string;
}

/**
 * The key the arrow keys move to from `active`: Left/Right step and wrap,
 * Home/End jump to the ends. Null for any other key. Pure.
 */
export function tabKeyTarget(keys: readonly string[], active: string, key: string): string | null {
  const at = keys.indexOf(active);
  if (at < 0 || keys.length === 0) return null;
  const last = keys.length - 1;
  if (key === 'ArrowRight') return keys[at === last ? 0 : at + 1] ?? null;
  if (key === 'ArrowLeft') return keys[at === 0 ? last : at - 1] ?? null;
  if (key === 'Home') return keys[0] ?? null;
  if (key === 'End') return keys[last] ?? null;
  return null;
}

/**
 * In-page tabs (Settings panels): a role="tablist" row of role="tab" buttons
 * with aria-selected, never aria-current="page" (that is for nav links). The
 * active tab is the one Tab stop; the arrow keys move between tabs. The row
 * looks like every chip row: tabs rest on the grey fill, the active tab is the
 * ink fill.
 */
export function Tabs({ items, active, onChange, label }: TabsProps) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const next = tabKeyTarget(
      items.map((tab) => tab.key),
      active,
      event.key,
    );
    if (next === null) return;
    event.preventDefault();
    onChange(next);
    refs.current.get(next)?.focus();
  }
  return (
    <div
      role="tablist"
      {...(label !== undefined ? { 'aria-label': label } : {})}
      onKeyDown={onKeyDown}
      className="flex items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {items.map((tab) => {
        const isActive = tab.key === active;
        return (
          <PressableRow
            key={tab.key}
            buttonRef={(el: HTMLButtonElement | null) => {
              if (el === null) refs.current.delete(tab.key);
              else refs.current.set(tab.key, el);
            }}
            type="button"
            inline
            align="center"
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            data-selected={isActive ? 'true' : undefined}
            onClick={() => onChange(tab.key)}
            className={cn(
              'flex shrink-0 items-center justify-center px-3 text-base font-medium whitespace-nowrap',
              isActive ? 'border border-fg text-fg' : 'border border-border text-fg-2',
            )}
          >
            {tab.label}
          </PressableRow>
        );
      })}
    </div>
  );
}
