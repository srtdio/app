// The Plan tab on a phone: the plans as cards in sections (This week, Next
// week, Later, Earlier; empty ones hidden). A card has the chat plan card's
// look (PLAN, the title on up to two lines, the mono date range) with the
// plan's covers, then a shared plan's bar and "N of M OK", or a Draft's tag
// and "N items · only your team sees this" ("1 item" for one). A tap opens the plan's own screen (full page). The phone
// Plan screens themselves are not touched. Tokens only. While more plans
// remain (the read's next cursor), Load more ends the list ('Loading' while
// the page is in flight, the Comments pattern); the cards it appends enter
// with a translateY only (duration-base, ease-enter).

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { PlanCardBar, PlanCardTop } from '@/components/chat/PlanCard';
import { PRESIGN_ENABLED, sharedCardPresignCache } from '@/components/chat/PostCard';
import { PLAN_DRAFT_LABEL } from '@/components/chat/plan-card';
import { Thumbnail } from '@/components/media/Thumbnail';
import { Button } from '@/components/ui/Button';
import { PressableRow } from '@/components/ui/PressableRow';
import type { PlanBundle, PlanThumbs } from '@/lib/chat/plans';
import { cn } from '@/lib/cn';
import { planCardMeta, planSections } from '@/lib/plan-tab';
import { usePlanTabMore } from './plan-tab-more';

/** Covers a card shows at most. */
export const CARD_COVERS = 4;

/** A plan's covers: its items' first images (posts, then concept images), in item order. Pure. */
export function planCovers(bundle: PlanBundle, thumbs: PlanThumbs): string[] {
  const out: string[] = [];
  for (const item of bundle.items) {
    const post = item.post_id !== null ? thumbs.posts[item.post_id] : undefined;
    const concept = thumbs.concepts[item.id];
    const version = post ?? (concept?.kind === 'image' ? concept.versionId : undefined);
    if (version !== undefined && !out.includes(version)) out.push(version);
    if (out.length === CARD_COVERS) break;
  }
  return out;
}

/**
 * Cards appended after the first paint (a Load more page): each renders one
 * frame lowered, then moves to rest. Cards of the first paint never move.
 * Returns the appended ids and the ones that have entered.
 */
function useAppended(ids: readonly string[]): { appended: Set<string>; entered: Set<string> } {
  const first = useRef<Set<string> | null>(null);
  if (first.current === null) first.current = new Set(ids);
  const initial = first.current;
  const appended = new Set(ids.filter((id) => !initial.has(id)));
  const [entered, setEntered] = useState<Set<string>>(() => new Set());
  const waiting = [...appended].filter((id) => !entered.has(id));
  const key = waiting.join(',');
  useEffect(() => {
    if (key === '') return;
    const raf = requestAnimationFrame(() => {
      setEntered((prev) => {
        const next = new Set(prev);
        for (const id of key.split(',')) next.add(id);
        return next;
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [key]);
  return { appended, entered };
}

export function PlanTabList(props: {
  bundles: readonly PlanBundle[];
  thumbs: PlanThumbs;
  today: string;
  onOpen: (planId: string) => void;
}): ReactElement {
  const more = usePlanTabMore();
  const { appended, entered } = useAppended(props.bundles.map((b) => b.plan.id));
  return (
    <div data-plan-tab-list="" className="flex flex-col gap-5 px-4 pb-8 pt-4">
      {planSections(props.bundles, props.today).map((section) => (
        <section
          key={section.key}
          data-plan-tab-section={section.key}
          className="flex flex-col gap-2"
        >
          <h2 className="text-sm font-semibold uppercase tracking-[0.06em] text-fg-2">
            {section.label}
          </h2>
          {section.bundles.map((bundle) => {
            const id = bundle.plan.id;
            const card = (
              <PlanTabCard
                key={id}
                bundle={bundle}
                covers={planCovers(bundle, props.thumbs)}
                onOpen={() => props.onOpen(id)}
              />
            );
            if (!appended.has(id)) return card;
            return (
              <div
                key={id}
                data-plan-tab-appended=""
                className={cn(
                  'flex flex-col transition-transform duration-base ease-enter motion-reduce:transition-none',
                  entered.has(id) ? 'translate-y-0' : 'translate-y-1',
                )}
              >
                {card}
              </div>
            );
          })}
        </section>
      ))}
      {more !== null ? (
        <Button
          type="button"
          data-plan-tab-more=""
          className="self-start"
          disabled={more.busy}
          onClick={more.onMore}
        >
          {more.busy ? 'Loading' : 'Load more'}
        </Button>
      ) : null}
    </div>
  );
}

/** One plan card of the list. */
export function PlanTabCard(props: {
  bundle: PlanBundle;
  covers: readonly string[];
  onOpen: () => void;
}): ReactElement {
  const meta = planCardMeta(props.bundle);
  return (
    <PressableRow
      type="button"
      data-plan-tab-card={props.bundle.plan.id}
      onClick={props.onOpen}
      className="flex flex-col gap-2 border border-border bg-panel px-3.5 pb-3 pt-3 transition-colors"
    >
      <PlanCardTop plan={props.bundle.plan} wrapTitle />
      {props.covers.length > 0 ? (
        <span className="flex h-10 gap-1.5">
          {props.covers.map((version) => (
            <span
              key={version}
              data-plan-tab-cover=""
              className="h-10 w-10 shrink-0 overflow-hidden rounded-md bg-panel-2"
            >
              <Thumbnail
                assetVersionId={version}
                cache={sharedCardPresignCache()}
                presignEnabled={PRESIGN_ENABLED}
                fallback={{ kind: 'glyph' }}
                alt=""
              />
            </span>
          ))}
        </span>
      ) : null}
      {meta.kind === 'shared' ? (
        <>
          <PlanCardBar
            label="Approved"
            value={meta.ok}
            max={meta.total}
            percent={meta.percent}
            side="client"
          />
          <span data-plan-tab-progress="" className="truncate text-sm leading-4 text-fg-3">
            {meta.label}
          </span>
        </>
      ) : (
        <span className="flex min-w-0 items-center gap-2">
          <DraftTag />
          <span data-plan-tab-progress="" className="truncate text-sm leading-4 text-fg-3">
            {meta.label}
          </span>
        </span>
      )}
    </PressableRow>
  );
}

/** The small Draft tag on a Draft plan (only the team sees it). */
export function DraftTag(): ReactElement {
  return (
    <span
      data-plan-tab-draft=""
      className="inline-flex h-5 shrink-0 items-center rounded-md bg-warn-soft px-1.5 text-xs font-semibold leading-4 text-warn"
    >
      {PLAN_DRAFT_LABEL}
    </span>
  );
}
