// The Plan tab on a phone: the plans as cards in sections (This week, Next
// week, Upcoming, Past; empty ones hidden). A card has the chat plan card's
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
import { GUTTER } from '@/components/ui/layout';
import { EmptyState } from '@/components/ui/EmptyState';
import { ICON_SIZE, IconPlan } from '@/components/ui/icons';
import { PLAN_WEEK_CHIP_ZERO, planCardMeta, planSections, type PlanWeekChip } from '@/lib/plan-tab';
import { Text } from '@/components/ui/Text';

/**
 * Load more's copy. It never swaps while the page is in flight: busy shows on
 * the button (Button busy), so the label keeps its width. Pure.
 */
export function loadMoreLabel(): string {
  return 'Load more';
}

/** What Load more needs: busy while a page is in flight, and the tap. Null: every plan is in. */
export interface PlanTabMore {
  busy: boolean;
  onMore: () => void;
}

/**
 * Load more (the Comments pattern): the shared Button, 44 tall, busy (its
 * label kept, the arc over it) while the page is in flight. The phone list and the laptop
 * calendar both end with it.
 */
export function PlanTabLoadMore(props: { more: PlanTabMore }): ReactElement {
  return (
    <Button
      type="button"
      data-plan-tab-load-more=""
      className="self-start"
      busy={props.more.busy}
      onClick={props.more.onMore}
    >
      {loadMoreLabel()}
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
  /** The picked chip: All shows every group with its heading; a group shows only itself, no heading (the chip names it). */
  chip: PlanWeekChip;
}): ReactElement {
  const { chip } = props;
  const sections = planSections(props.bundles, props.today).filter(
    (section) => chip === 'all' || section.key === chip,
  );
  // Keyed on every read plan, not the shown ones: a chip pick switches instantly (no rise).
  const rise = useAppendedRise(props.bundles.map((b) => b.plan.id));
  return (
    <div data-plan-tab-list="" className={cn('flex flex-col gap-6 pb-8 pt-4', GUTTER)}>
      {sections.length === 0 ? (
        <div data-plan-tab-chip-zero="">
          <EmptyState icon={<IconPlan size={ICON_SIZE.tray} />} title={PLAN_WEEK_CHIP_ZERO} />
        </div>
      ) : null}
      {sections.map((section) => (
        <section
          key={section.key}
          data-plan-tab-section={section.key}
          className="flex flex-col gap-4"
        >
          {chip === 'all' ? (
            <Text as="h2" role="section">
              {section.label}
            </Text>
          ) : null}
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
      className="lit-card flex flex-col gap-2 border bg-panel p-4 mv-tint"
    >
      <PlanCardTop plan={props.bundle.plan} wrapTitle />
      {props.covers.length > 0 ? (
        <span className="flex h-10 gap-2">
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
          <span data-plan-tab-progress="" className="truncate text-sm text-fg-3">
            {meta.label}
          </span>
        </>
      ) : (
        <span className="flex min-w-0 items-center gap-2">
          <DraftTag />
          <span data-plan-tab-progress="" className="truncate text-sm text-fg-3">
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
/** `heading`: the group heading's bone, drawn only where the list will have one (All, search). */
export function PlanTabBoxes(props: { heading?: boolean } = {}): ReactElement {
  const heading = props.heading ?? true;
  return (
    <BoxSkeleton
      lit="flat"
      label="Loading plans"
      data-plan-tab-loading=""
      className={cn('flex flex-col gap-6 pb-8 pt-4', GUTTER)}
    >
      <section className="flex flex-col gap-4">
        {heading ? (
          <div className="flex h-4 items-center">
            <Bone lit="flat" className="h-3 w-20 rounded" />
          </div>
        ) : null}
        {[0, 1, 2].map((key) => (
          <div
            key={key}
            data-plan-tab-box=""
            className="lit-card flex flex-col gap-2 rounded-xl border bg-panel p-4"
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
            <div className="flex h-10 gap-2">
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
