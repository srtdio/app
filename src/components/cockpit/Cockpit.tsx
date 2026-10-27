// The operator's Cockpit: the health dot in the top bar and the live panel
// (laptop: SidePanel beside the page; phone: a bottom Sheet). This module and
// everything it imports load only through AppLayout's React.lazy, which runs
// only when the operator flag is true: nobody else downloads or requests any
// of it.

import { useEffect, useRef } from 'react';
import type { ReactNode, TouchEvent } from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { PressableRow } from '@/components/ui/PressableRow';
import { Chip } from '@/components/ui/Chip';
import { Sheet } from '@/components/ui/Sheet';
import { SidePanel } from '@/components/ui/SidePanel';
import { tagClass } from '@/components/ui/Tag';
import { StatusDot } from '@/components/cockpit/parts';
import {
  ChatTab,
  EmailTab,
  ErrorsTab,
  LogsTab,
  NeedsYouTab,
  TrafficTab,
  UsersTab,
} from '@/components/cockpit/tabs';
import { cn } from '@/lib/cn';
import { fetchCockpitFull, fetchCockpitStatus } from '@/lib/cockpit/client';
import { clockText, countText, dotLabel } from '@/lib/cockpit/format';
import {
  browserVisibility,
  browserWhenIdle,
  createCockpitPoller,
  type CockpitPoller,
} from '@/lib/cockpit/poll';
import { useCockpitState, type CockpitState } from '@/lib/cockpit/store';
import {
  COCKPIT_TABS,
  COCKPIT_TILES,
  type CockpitFull,
  type CockpitTab,
  type TabDataMap,
} from '@/lib/cockpit/types';
import { mark } from '@/lib/perf-marks';
import { useIsLaptop } from '@/lib/use-is-laptop';

let poller: CockpitPoller | null = null;

/** The one poller of this page load (session memory lives in the store). */
export function cockpitPoller(): CockpitPoller {
  poller ??= createCockpitPoller({
    fetchStatus: fetchCockpitStatus,
    fetchFull: fetchCockpitFull,
    isVisible: () => document.visibilityState === 'visible',
    onVisibilityChange: browserVisibility,
    whenIdle: browserWhenIdle,
    now: () => Date.now(),
    setTimer: (run, ms) => window.setTimeout(run, ms),
    clearTimer: (id) => window.clearTimeout(id as number),
  });
  return poller;
}

let dotPainted = false;

/** Grey on its first frame; the first idle status fetch colours it. Nothing waits on it. */
export function CockpitDot() {
  const { level, open } = useCockpitState();
  if (!dotPainted) {
    dotPainted = true;
    mark('cockpit:dot-paint');
  }
  useEffect(() => {
    const p = cockpitPoller();
    p.start();
    return () => p.stop();
  }, []);
  return (
    <IconButton
      type="button"
      label={dotLabel(level)}
      aria-expanded={open}
      data-cockpit-dot={level}
      onClick={(event) => {
        // WebKit does not focus a clicked button: focus it, so Esc returns here.
        event.currentTarget.focus({ preventScroll: true });
        if (open) cockpitPoller().close();
        else cockpitPoller().open();
      }}
      className={cn('shrink-0', open && 'bg-accent-soft')}
    >
      <StatusDot level={level} />
    </IconButton>
  );
}

/** "Live" with a green dot, and the last refresh as HH:MM:SS. */
function LiveStamp({ checkedAt }: { checkedAt: string | null }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className={cn(tagClass('good'), 'gap-1.5')}>
        <StatusDot level="green" small />
        Live
      </span>
      <span className="font-mono text-sm tabular-nums text-fg-3" data-cockpit-stamp="">
        {clockText(checkedAt)}
      </span>
    </span>
  );
}

function Tiles({ state, onPick }: { state: CockpitState; onPick: (tab: CockpitTab) => void }) {
  const tiles = state.latest?.tiles;
  return (
    <div className="grid grid-cols-3 gap-2">
      {COCKPIT_TILES.map(({ key, label, tab }) => {
        const tile = tiles?.[key];
        const selected = state.tab === tab;
        return (
          <PressableRow
            key={key}
            card
            aria-pressed={selected}
            onClick={() => onPick(tab)}
            className={cn(
              'flex min-w-0 flex-col gap-1 border px-3 py-2.5',
              selected ? 'border-accent-line bg-accent-soft' : 'border-border',
            )}
          >
            <span className="flex w-full items-center gap-1.5">
              <StatusDot
                level={tile === undefined ? 'grey' : tile.state === 'ok' ? tile.level : 'amber'}
                small
              />
              <span className="truncate text-sm text-fg-2">{label}</span>
            </span>
            {tile === undefined ? (
              <span aria-hidden="true" className="h-7 w-10 rounded bg-panel-3 animate-pulse" />
            ) : tile.state === 'ok' ? (
              <span className="font-mono text-2xl font-semibold tabular-nums text-fg">
                {countText(tile.value)}
              </span>
            ) : (
              <span className="text-sm text-fg-2 line-clamp-2">{tile.reason}</span>
            )}
          </PressableRow>
        );
      })}
    </div>
  );
}

function tabData<T extends CockpitTab>(state: CockpitState, tab: T): TabDataMap[T] | undefined {
  const full = state.byTab[tab] as unknown as CockpitFull<T> | undefined;
  return full?.data;
}

/** Tiles, the tab row and the picked tab: painted from memory, refreshed by the poller. */
export function CockpitBody({ state }: { state: CockpitState }) {
  const pick = (tab: CockpitTab): void => cockpitPoller().selectTab(tab);
  return (
    <div className="flex flex-col gap-4 p-4">
      <Tiles state={state} onPick={pick} />
      <div role="tablist" aria-label="Cockpit" className="-mx-4 flex gap-2 overflow-x-auto px-4">
        {COCKPIT_TABS.map(({ id, label }) => (
          <Chip
            key={id}
            role="tab"
            aria-selected={state.tab === id}
            label={label}
            selected={state.tab === id}
            onClick={() => pick(id)}
            className="shrink-0"
          />
        ))}
      </div>
      <div role="tabpanel" aria-label={COCKPIT_TABS.find((t) => t.id === state.tab)?.label}>
        {state.tab === 'needs' ? (
          <NeedsYouTab alerts={state.alerts} checkedAt={state.checkedAt} onOpenTab={pick} />
        ) : state.tab === 'users' ? (
          <UsersTab source={tabData(state, 'users')} />
        ) : state.tab === 'errors' ? (
          <ErrorsTab source={tabData(state, 'errors')} />
        ) : state.tab === 'logs' ? (
          <LogsTab source={tabData(state, 'logs')} />
        ) : state.tab === 'email' ? (
          <EmailTab source={tabData(state, 'email')} />
        ) : state.tab === 'chat' ? (
          <ChatTab source={tabData(state, 'chat')} />
        ) : (
          <TrafficTab source={tabData(state, 'traffic')} />
        )}
      </div>
    </div>
  );
}

/** A downward swipe that starts at the top of the sheet's scroll closes it. */
export const SWIPE_CLOSE_PX = 80;

/** Whether a touch from startY to endY, begun with the sheet scrolled to its top, closes it. */
export function swipeCloses(start: { y: number; atTop: boolean } | null, endY: number): boolean {
  return start !== null && start.atTop && endY - start.y > SWIPE_CLOSE_PX;
}

function SwipeToClose({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const start = useRef<{ y: number; atTop: boolean } | null>(null);
  function scrollerTop(el: HTMLElement | null): boolean {
    for (let node = el; node !== null; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight && getComputedStyle(node).overflowY !== 'visible') {
        return node.scrollTop <= 0;
      }
    }
    return true;
  }
  return (
    <div
      data-cockpit-swipe=""
      onTouchStart={(e: TouchEvent<HTMLDivElement>) => {
        const t = e.touches[0];
        start.current =
          t === undefined ? null : { y: t.clientY, atTop: scrollerTop(e.currentTarget) };
      }}
      onTouchEnd={(e: TouchEvent<HTMLDivElement>) => {
        const t = e.changedTouches[0];
        const s = start.current;
        start.current = null;
        if (t !== undefined && swipeCloses(s, t.clientY)) onClose();
      }}
    >
      {children}
    </div>
  );
}

/** Laptop: SidePanel beside the page (nothing dims). Phone: a bottom Sheet over a scrim. */
export function CockpitPanel() {
  const isLaptop = useIsLaptop();
  const state = useCockpitState();
  const close = (): void => cockpitPoller().close();
  if (state.open) mark('cockpit:panel-paint');
  if (isLaptop) {
    return (
      <SidePanel
        open={state.open}
        onClose={close}
        title="Cockpit"
        headerExtra={<LiveStamp checkedAt={state.checkedAt} />}
      >
        <CockpitBody state={state} />
      </SidePanel>
    );
  }
  return (
    <Sheet open={state.open} onClose={close} title="Cockpit">
      <SwipeToClose onClose={close}>
        {/* Tall from its first frame: the sheet opens at its full height (Sheet caps it
            at 90dvh), so a tab that loads or changes never grows it. */}
        <div className="-mx-[18px] -mt-4 flex min-h-[85svh] flex-col">
          <div className="px-4 pt-3">
            <LiveStamp checkedAt={state.checkedAt} />
          </div>
          <CockpitBody state={state} />
        </div>
      </SwipeToClose>
    </Sheet>
  );
}
