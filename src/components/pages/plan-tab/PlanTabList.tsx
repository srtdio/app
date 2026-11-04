// The Plan tab on a phone: the plans as cards in sections (This week, Next
// week, Later, Earlier; empty ones hidden). A card has the chat plan card's
// look (PLAN, the title on up to two lines, the mono date range) with the
// plan's covers, then a shared plan's bar and "N of M OK", or a Draft's tag
// and "N items · only your team sees this" ("1 item" for one). A tap opens the plan's own screen (full page). The phone
// Plan screens themselves are not touched. Tokens only. While more plans
// remain (the read's next cursor), PlanTabPage hands the list its Load more
// (from usePlanTabData) and the list ends with it (PlanTabLoadMore, which the
// laptop calendar ends with too); the cards it appends rise into place
// (itemIn, Y only, laid over their final state; never a fade).

import { useLayoutEffect, useRef, type ReactElement } from 'react';
import { Bone, BoxSkeleton, itemIn, rememberCard, useFreshKeys } from '@/lib/motion';
import { PlanCardBar, PlanCardTop } from '@/components/chat/PlanCard';
import { PRESIGN_ENABLED, sharedCardPresignCache } from '@/components/chat/PostCard';
import { PLAN_DRAFT_LABEL } from '@/components/chat/plan-card';
import { Thumbnail } from '@/components/media/Thumbnail';
import { Button } from '@/components/ui/Button';
import { PressableRow } from '@/components/ui/PressableRow';
import { tagClass } from '@/components/ui/Tag';
import type { PlanBundle, PlanThumbs } from '@/lib/chat/plans';
import { cn } from '@/lib/cn';
import { planCardMeta, planSections } from '@/lib/plan-tab';

/** Load more's copy: 'Loading' while the page is in flight. Pure. */
export function loadMoreLabel(busy: boolean): string {
  return busy ? 'Loading' : 'Load more';
}

/** What Load more needs: busy while a page is in flight, and the tap. Null: every plan is in. */
export interface PlanTabMore {
  busy: boolean;
  onMore: () => void;
}

/**
 * Load more (the Comments pattern): the shared Button, 44 tall, disabled and
 * 'Loading' while the page is in flight. The phone list and the laptop
 * calendar both end with it.
 */
export function PlanTabLoadMore(props: { more: PlanTabMore }): ReactElement {
  return (
    <Button
      type="button"
      data-plan-tab-load-more=""
      className="self-start"
      disabled={props.more.busy}
      onClick={props.more.onMore}
    >
      {loadMoreLabel(props.more.busy)}
    </Button>
  );
}

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
 * Cards appended after the first paint (a Load more page) rise into place
 * (itemIn) over their final state. Cards of the first paint never move.
 * Returns the ref callback for each card's wrapper.
 */
function useAppendedRise(ids: readonly string[]): (id: string) => (el: HTMLElement | null) => void {
  const fresh = useFreshKeys(ids);
  const els = useRef(new Map<string, HTMLElement>());
  useLayoutEffect(() => {
    for (const id of fresh) itemIn(els.current.get(id) ?? null);
  });
  return (id) => (el) => {
    if (el === null) els.current.delete(id);
    else els.current.set(id, el);
  };
}

export function PlanTabList(props: {
  bundles: readonly PlanBundle[];
  thumbs: PlanThumbs;
  today: string;
  onOpen: (planId: string) => void;
  /** Load more while more plans remain; null when every plan is in. */
  more: PlanTabMore | null;
}): ReactElement {
  const rise = useAppendedRise(props.bundles.map((b) => b.plan.id));
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
            return (
              <div key={id} ref={rise(id)} className="flex flex-col">
                <PlanTabCard
                  bundle={bundle}
                  covers={planCovers(bundle, props.thumbs)}
                  onOpen={() => props.onOpen(id)}
                />
              </div>
            );
          })}
        </section>
      ))}
      {props.more !== null ? <PlanTabLoadMore more={props.more} /> : null}
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
      card
      type="button"
      data-plan-tab-card={props.bundle.plan.id}
      onClick={(event) => {
        // growFromCard: the plan's page grows out of this card.
        rememberCard(props.bundle.plan.id, event.currentTarget);
        props.onOpen();
      }}
      className="lit-card flex flex-col gap-2 border bg-panel px-3.5 pb-3 pt-3 mv-tint"
    >
      <PlanCardTop plan={props.bundle.plan} wrapTitle />
      {props.covers.length > 0 ? (
        <span className="flex h-10 gap-1.5">
          {props.covers.map((version) => (
            <span
              key={version}
              data-plan-tab-cover=""
              className="h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-panel-2 lit-media"
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
    <span data-plan-tab-draft="" className={cn(tagClass('warn'), 'shrink-0')}>
      {PLAN_DRAFT_LABEL}
    </span>
  );
}

/**
 * The phone Plan tab's loading boxes (sweepBoxes): a section label, then
 * plan-card-shaped Bones in PlanTabCard's own layout (eyebrow, title, mono
 * range, covers, the progress line). Only when nothing is held for the tab.
 */
export function PlanTabBoxes(): ReactElement {
  return (
    <BoxSkeleton
      lit="flat"
      label="Loading plans"
      data-plan-tab-loading=""
      className="flex flex-col gap-5 px-4 pb-8 pt-4"
    >
      <section className="flex flex-col gap-2">
        <div className="flex h-4 items-center">
          <Bone lit="flat" className="h-3 w-20 rounded" />
        </div>
        {[0, 1, 2].map((key) => (
          <div
            key={key}
            data-plan-tab-box=""
            className="lit-card flex flex-col gap-2 rounded-xl border bg-panel px-3.5 pb-3 pt-3"
          >
            <div className="flex h-4 items-center">
              <Bone lit="flat" className="h-3 w-12 rounded" />
            </div>
            <div className="flex h-7 items-center">
              <Bone lit="flat" className="h-5 w-2/3 rounded" />
            </div>
            <div className="flex h-5 items-center">
              <Bone lit="flat" className="h-3.5 w-32 rounded" />
            </div>
            <div className="flex h-10 gap-1.5">
              <Bone lit="lit-media" className="h-10 w-10 shrink-0 rounded-lg" />
              <Bone lit="lit-media" className="h-10 w-10 shrink-0 rounded-lg" />
              <Bone lit="lit-media" className="h-10 w-10 shrink-0 rounded-lg" />
            </div>
            <div className="flex h-4 items-center">
              <Bone lit="flat" className="h-3 w-1/3 rounded" />
            </div>
          </div>
        ))}
      </section>
    </BoxSkeleton>
  );
}
