// The Plan tab on a phone: the plans as cards in sections (This week, Next
// week, Later, Earlier; empty ones hidden). A card has the chat plan card's
// look (PLAN, the title on up to two lines, the mono date range) with the
// plan's covers, then a shared plan's bar and "N of M OK", or a Draft's tag
// and "N items · only your team sees this" ("1 item" for one). A tap opens the plan's own screen (full page). The phone
// Plan screens themselves are not touched. Tokens only.

import type { ReactElement } from 'react';
import { PlanCardBar, PlanCardTop } from '@/components/chat/PlanCard';
import { PRESIGN_ENABLED, sharedCardPresignCache } from '@/components/chat/PostCard';
import { PLAN_DRAFT_LABEL } from '@/components/chat/plan-card';
import { Thumbnail } from '@/components/media/Thumbnail';
import type { PlanBundle, PlanThumbs } from '@/lib/chat/plans';
import { planCardMeta, planSections } from '@/lib/plan-tab';

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

export function PlanTabList(props: {
  bundles: readonly PlanBundle[];
  thumbs: PlanThumbs;
  today: string;
  onOpen: (planId: string) => void;
}): ReactElement {
  return (
    <div data-plan-tab-list="" className="flex flex-col gap-5 px-4 pb-8 pt-4">
      {planSections(props.bundles, props.today).map((section) => (
        <section
          key={section.key}
          data-plan-tab-section={section.key}
          className="flex flex-col gap-2"
        >
          <h2 className="text-legacy-xs font-semibold uppercase tracking-wide text-fg-3">
            {section.label}
          </h2>
          {section.bundles.map((bundle) => (
            <PlanTabCard
              key={bundle.plan.id}
              bundle={bundle}
              covers={planCovers(bundle, props.thumbs)}
              onOpen={() => props.onOpen(bundle.plan.id)}
            />
          ))}
        </section>
      ))}
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
    <button
      type="button"
      data-plan-tab-card={props.bundle.plan.id}
      onClick={props.onOpen}
      className="flex w-full flex-col gap-2 rounded-lg border border-border bg-panel px-3.5 pb-3 pt-3 text-left transition-colors hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
          <span data-plan-tab-progress="" className="truncate text-legacy-xs leading-4 text-fg-3">
            {meta.label}
          </span>
        </>
      ) : (
        <span className="flex min-w-0 items-center gap-2">
          <DraftTag />
          <span data-plan-tab-progress="" className="truncate text-legacy-xs leading-4 text-fg-3">
            {meta.label}
          </span>
        </span>
      )}
    </button>
  );
}

/** The small Draft tag on a Draft plan (only the team sees it). */
export function DraftTag(): ReactElement {
  return (
    <span
      data-plan-tab-draft=""
      className="inline-flex h-5 shrink-0 items-center rounded-md bg-warn-soft px-1.5 text-[11px] font-semibold leading-4 text-warn"
    >
      {PLAN_DRAFT_LABEL}
    </span>
  );
}
