// The Plan tab's list, phone and laptop alike (the laptop Month | Week calendar
// retired 7 Nov 2026): one ui/ListCard per plan in LIST_CARD_GRID (one column
// on a phone, auto-fill columns on a laptop): Upcoming groups This week, Next
// week and Later under their headings (empty ones hidden); Past is one list
// with no heading (the chip names it). A card: the
// plan's first cover (else the plan icon), its title and its time on line 1
// (formatPlanStart: "Today", "Mon", "16 Nov" before it starts, "Live" while
// on, its end day "1 Nov" once over), then on line 2 its dates and post count
// (a Draft adds "only your team sees this") and one grey tag ("1 of 3 OK", or
// "Draft"). No select: long-press does nothing. A tap opens the plan's own
// screen. While more plans remain (the
// read's next cursor), PlanTabPage hands the list its Load more (from
// usePlanTabData) and the list ends with it (PlanTabLoadMore, which the Bank
// and From bank end with too); the cards it appends rise into place (itemIn,
// Y only, laid over their final state; never a fade).

import { useLayoutEffect, useRef, type ReactElement } from 'react';
import { BoxSkeleton, Bone, itemIn, rememberCard, useFreshKeys } from '@/lib/motion';
import { PRESIGN_ENABLED, sharedCardPresignCache } from '@/components/chat/PostCard';
import { Thumbnail } from '@/components/media/Thumbnail';
import { LIST_CARD_GRID, ListCard, ListCardBox } from '@/components/ui/ListCard';
import type { PlanBundle, PlanThumbs } from '@/lib/chat/plans';
import { cn } from '@/lib/cn';
import { GUTTER } from '@/components/ui/layout';
import { EmptyState } from '@/components/ui/EmptyState';
import { ICON_SIZE, IconPlan } from '@/components/ui/icons';
import {
  PLAN_WEEK_CHIP_ZERO,
  planCardMeta,
  planCardPreview,
  planChipHolds,
  planSections,
  type PlanWeekChip,
} from '@/lib/plan-tab';
import { formatPlanStart } from '@/lib/time';
import { Text } from '@/components/ui/Text';
import { getFillCount } from '@/lib/use-fill-count';
import { LoadMore, LOAD_MORE_LABEL } from '@/components/ui/LoadMore';

/**
 * Load more's copy. It never swaps while the page is in flight: busy shows on
 * the button (Button busy), so the label keeps its width. Pure.
 */
export function loadMoreLabel(): string {
  return LOAD_MORE_LABEL;
}

/** What Load more needs: busy while a page is in flight, and the tap. Null: every plan is in. */
export interface PlanTabMore {
  busy: boolean;
  onMore: () => void;
}

/**
 * Load more: the shared ui/LoadMore (Button level, left aligned, busy keeps
 * its width) while the page is in flight. The plan list, the Bank and From
 * bank end with it.
 */
export function PlanTabLoadMore(props: { more: PlanTabMore }): ReactElement {
  return <LoadMore data-plan-tab-load-more="" busy={props.more.busy} onMore={props.more.onMore} />;
}

/**
 * A plan's picture: its items' first image (a post's, else a concept image),
 * in item order; null when none holds one. Pure.
 */
export function planCover(bundle: PlanBundle, thumbs: PlanThumbs): string | null {
  for (const item of bundle.items) {
    const post = item.post_id !== null ? thumbs.posts[item.post_id] : undefined;
    const concept = thumbs.concepts[item.id];
    const version = post ?? (concept?.kind === 'image' ? concept.versionId : undefined);
    if (version !== undefined) return version;
  }
  return null;
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
  /** The workspace zone the dates read on. */
  timeZone: string;
  /** The one list clock (useMinuteClock, PlanTabPage). */
  now: Date;
  onOpen: (planId: string) => void;
  /** Load more while more plans remain; null when every plan is in. */
  more: PlanTabMore | null;
  /** The picked chip: Upcoming shows This week, Next week and Later, each under its heading; Past shows only itself, no heading (the chip names it). */
  chip: PlanWeekChip;
}): ReactElement {
  const { chip } = props;
  const sections = planSections(props.bundles, props.today).filter((section) =>
    planChipHolds(chip, section.key),
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
          {chip === 'upcoming' ? (
            <Text as="h2" role="section">
              {section.label}
            </Text>
          ) : null}
          <div className={LIST_CARD_GRID}>
            {section.bundles.map((bundle) => {
              const id = bundle.plan.id;
              return (
                <div key={id} ref={rise(id)} className="flex min-w-0 flex-col">
                  <PlanTabCard
                    bundle={bundle}
                    cover={planCover(bundle, props.thumbs)}
                    timeZone={props.timeZone}
                    now={props.now}
                    onOpen={() => props.onOpen(id)}
                  />
                </div>
              );
            })}
          </div>
        </section>
      ))}
      {props.more !== null ? <PlanTabLoadMore more={props.more} /> : null}
    </div>
  );
}

/**
 * One plan on ui/ListCard: the first cover (else the plan icon), the title and
 * its time (formatPlanStart with the end day), then the dates and post count
 * (one line) and the one tag ("1 of 3 OK", or "Draft"). The whole card opens
 * the plan; its page grows out of the card (rememberCard).
 */
export function PlanTabCard(props: {
  bundle: PlanBundle;
  /** The first cover's asset version; null shows the plan icon. */
  cover: string | null;
  timeZone: string;
  now: Date;
  onOpen: () => void;
}): ReactElement {
  const { bundle, cover } = props;
  const plan = bundle.plan;
  const meta = planCardMeta(bundle);
  const rootRef = useRef<HTMLElement>(null);
  return (
    <ListCard
      rootRef={rootRef}
      surface={{ 'data-plan-tab-card': plan.id }}
      onPress={() => {
        // growFromCard: the plan's page grows out of this card.
        rememberCard(plan.id, rootRef.current);
        props.onOpen();
      }}
      picture={
        cover !== null
          ? {
              kind: 'image',
              node: (
                <Thumbnail
                  assetVersionId={cover}
                  cache={sharedCardPresignCache()}
                  presignEnabled={PRESIGN_ENABLED}
                  aspect="square"
                  fallback={{ kind: 'glyph' }}
                  fallbackTile={
                    <span className="flex h-full w-full items-center justify-center bg-panel-2 text-fg-2">
                      <IconPlan size={ICON_SIZE.control} />
                    </span>
                  }
                  alt=""
                />
              ),
            }
          : { kind: 'icon', icon: IconPlan }
      }
      pictureHooks={{ 'data-plan-tab-cover': cover !== null ? 'image' : 'icon' }}
      title={plan.title}
      preview={planCardPreview(bundle, props.timeZone, props.now)}
      previewHooks={{ 'data-plan-tab-dates': '' }}
      time={formatPlanStart(plan.starts_on, props.timeZone, props.now, plan.ends_on)}
      timeHooks={{ 'data-plan-tab-start': '' }}
      tag={meta.tag}
      tagHooks={
        meta.kind === 'draft' ? { 'data-plan-tab-draft': '' } : { 'data-plan-tab-progress': '' }
      }
    />
  );
}

/**
 * The Plan tab's loading boxes (sweepBoxes): ListCard's own loading box in the
 * list's grid, so nothing moves when the cards land. Only when nothing is held
 * for the tab. `heading`: the group heading's bone, drawn only where the list
 * will have one (the grouped Upcoming list).
 */
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
        <div className={LIST_CARD_GRID}>
          {Array.from({ length: getFillCount() }, (_unused, key) => (
            <ListCardBox key={key} data-plan-tab-box="" />
          ))}
        </div>
      </section>
    </BoxSkeleton>
  );
}
