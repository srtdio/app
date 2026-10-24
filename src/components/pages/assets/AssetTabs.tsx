import { useRef, type KeyboardEvent } from 'react';
import { cn } from '@/lib/cn';
import { ASSET_TABS, TAB_LABELS, type AssetTab } from '@/lib/assets';

/** The id of the region the tabs filter; AssetsPage puts it on the results. */
export const ASSET_TABPANEL_ID = 'assets-tabpanel';

export function assetTabId(tab: AssetTab): string {
  return `assets-tab-${tab}`;
}

/** The tab an arrow, Home or End key moves to from `current`, or null for other keys. Pure. */
export function nextTab(current: AssetTab, key: string): AssetTab | null {
  const at = ASSET_TABS.indexOf(current);
  const last = ASSET_TABS.length - 1;
  let to: number;
  if (key === 'ArrowRight') to = at === last ? 0 : at + 1;
  else if (key === 'ArrowLeft') to = at === 0 ? last : at - 1;
  else if (key === 'Home') to = 0;
  else if (key === 'End') to = last;
  else return null;
  return ASSET_TABS[to] ?? null;
}

interface AssetTabsProps {
  value: AssetTab;
  counts: Record<AssetTab, number>;
  onChange: (tab: AssetTab) => void;
}

/**
 * All, Media, PDF, Docs, Sheets, Links: a real tablist (roving tabindex, arrow
 * keys select), every tab always shown with its count, 44px tall. The row
 * scrolls sideways inside SectionHeader on a narrow phone.
 */
export function AssetTabs({ value, counts, onChange }: AssetTabsProps) {
  const refs = useRef(new Map<AssetTab, HTMLButtonElement>());

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const to = nextTab(value, event.key);
    if (to === null) return;
    event.preventDefault();
    onChange(to);
    const el = refs.current.get(to);
    el?.focus();
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  return (
    <div role="tablist" aria-label="File types" className="flex gap-2" onKeyDown={onKeyDown}>
      {ASSET_TABS.map((tab) => {
        const selected = tab === value;
        return (
          <button
            key={tab}
            ref={(el) => {
              if (el === null) refs.current.delete(tab);
              else refs.current.set(tab, el);
            }}
            type="button"
            role="tab"
            id={assetTabId(tab)}
            aria-selected={selected}
            aria-controls={ASSET_TABPANEL_ID}
            tabIndex={selected ? 0 : -1}
            data-asset-tab={tab}
            onClick={() => onChange(tab)}
            className={cn(
              'inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-1.5 rounded-lg border px-4 text-sm font-normal transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
              selected
                ? 'border-accent-line bg-accent-soft text-accent'
                : 'border-border text-fg-2 hover:bg-panel-2',
            )}
          >
            {TAB_LABELS[tab]} <span className="tabular-nums">{counts[tab]}</span>
          </button>
        );
      })}
    </div>
  );
}
