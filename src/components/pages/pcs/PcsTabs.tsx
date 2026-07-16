// The mobile PCS segmented control (F-layout): below md the post/comment split
// becomes two tabs, "Post" (gallery, caption, stage actions) and "Feedback"
// (comments). The active tab lives in the ?tab= search param so the browser
// back button restores the previous tab. Everything except the thin component
// wrapper is hookless/pure so the unit env (node, no DOM) can exercise it
// directly, mirroring CaptionView's captionView.

import type { ReactElement } from 'react';
import { cn } from '@/lib/cn';

export type PcsTab = 'post' | 'feedback';

/** The search param carrying the active tab. Absent means 'post'. */
export const PCS_TAB_PARAM = 'tab';

export const PCS_TABS: ReadonlyArray<{ value: PcsTab; label: string }> = [
  { value: 'post', label: 'Post' },
  { value: 'feedback', label: 'Feedback' },
];

/** Parse the ?tab= value; anything but 'feedback' (including absent) is 'post'. */
export function parsePcsTab(value: string | null): PcsTab {
  return value === 'feedback' ? 'feedback' : 'post';
}

/**
 * A copy of `params` with the tab param set. The default tab is DELETED rather
 * than written so the canonical post-tab URL stays clean; sibling params are
 * preserved untouched. Never mutates its input.
 */
export function withPcsTab(params: URLSearchParams, tab: PcsTab): URLSearchParams {
  const next = new URLSearchParams(params);
  if (tab === 'post') next.delete(PCS_TAB_PARAM);
  else next.set(PCS_TAB_PARAM, tab);
  return next;
}

/** The tabpanel DOM id a tab button points at via aria-controls. */
export function pcsTabPanelId(tab: PcsTab): string {
  return `pcs-tabpanel-${tab}`;
}

/**
 * Panel visibility + swap-motion classes for one tab panel. A hidden panel is
 * display:none only below md (both columns always show on desktop). The swap
 * animates opacity/translateY only, per the motion tokens; md+ pins the resting
 * values so desktop never dips during a param-driven tab change.
 */
export function pcsTabPanelClass(visible: boolean, entered: boolean): string {
  return cn(
    'flex-col gap-6 transition-[opacity,transform] duration-fast ease-enter',
    visible ? 'flex' : 'hidden md:flex',
    entered
      ? 'translate-y-0 opacity-100'
      : 'translate-y-1 opacity-0 md:translate-y-0 md:opacity-100',
  );
}

/**
 * The segmented control itself, hookless. Styling mirrors CompareVersionsView's
 * segmented mode picker (token border/panel shell, accent fill on the active
 * segment) at the 44px touch-target minimum.
 */
export function pcsTabButtons(active: PcsTab, onSelect: (tab: PcsTab) => void): ReactElement {
  return (
    <div
      role="tablist"
      aria-label="Post sections"
      className="flex w-full rounded-lg border border-border bg-panel-2 p-[3px]"
    >
      {PCS_TABS.map((tab) => {
        const selected = tab.value === active;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={pcsTabPanelId(tab.value)}
            onClick={() => onSelect(tab.value)}
            className={cn(
              'min-h-[44px] flex-1 rounded-md px-3 text-sm font-medium transition-colors duration-fast focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              selected ? 'bg-accent text-accent-fg' : 'text-fg-2 hover:text-fg',
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export function PcsTabs({
  active,
  onSelect,
}: {
  active: PcsTab;
  onSelect: (tab: PcsTab) => void;
}): ReactElement {
  return pcsTabButtons(active, onSelect);
}
