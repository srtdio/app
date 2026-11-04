// The Plan item screen for a concept, recreated from PlanItemScreen.tsx: the
// one-line header ("Concept N of M", the plan title), Files, the description
// card, the status box (Date, Approvers, and here a Post row), the link
// actions under the box (agency only), then Comments. Phone: a full page over
// the plan. Laptop: the 440px right-hand panel (PLAN_PANEL_WIDTH).

import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { PressableRow } from '@/components/ui/PressableRow';
import { Tag } from '@/components/ui/Tag';
import {
  ICON_SIZE,
  IconChevronLeft,
  IconChevronRight,
  IconImage,
  IconLink,
  IconMore,
  IconX,
} from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { ITEMS, PLAN } from './fixtures';
import type { FixtureConcept, FixturePost, Viewer } from './fixtures';
import {
  DRAFT_NOT_READY,
  POST_NOT_MADE_LABEL,
  SECTION_LABEL,
  StatusPill,
  dayHeader,
  postLine,
} from './shared';

export function ConceptScreen(props: {
  concept: FixtureConcept;
  linked: FixturePost | null;
  viewer: Viewer;
  laptop: boolean;
  onBack: () => void;
  onLink: () => void;
  onUnlink: () => void;
  onOpenPost: () => void;
}): ReactElement {
  const { concept, linked, viewer } = props;
  const agency = viewer === 'agency';
  const concepts = ITEMS.filter((i) => i.kind === 'concept');
  const at = concepts.findIndex((i) => i.id === concept.id) + 1;
  const locked = linked !== null && viewer === 'client' && linked.stage === 'draft';
  return (
    <div
      data-proto-concept={concept.id}
      role={props.laptop ? 'complementary' : 'dialog'}
      aria-label={`Concept ${at} of ${concepts.length}`}
      className={cn(
        'fixed z-40 flex flex-col',
        props.laptop
          ? 'inset-y-0 right-0 w-[440px] border-l border-border bg-panel'
          : 'inset-0 bg-bg ring-1 ring-border',
      )}
    >
      <header className="relative z-20 flex min-h-[60px] shrink-0 items-center gap-2 border-b bg-panel pl-4 pr-4 lit-header">
        <IconButton
          type="button"
          label="Back to plan"
          data-proto-back=""
          onClick={props.onBack}
          className="-ml-[11px] shrink-0 text-fg"
        >
          <IconChevronLeft size={ICON_SIZE.control} />
        </IconButton>
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="truncate text-lg font-semibold text-fg">{`Concept ${at} of ${concepts.length}`}</h2>
          <span className="truncate text-sm text-fg-3">{PLAN.title}</span>
        </div>
        {agency ? (
          <IconButton type="button" label="Item actions" className="shrink-0 text-fg">
            <IconMore size={ICON_SIZE.control} />
          </IconButton>
        ) : null}
        {props.laptop ? (
          <IconButton
            type="button"
            label="Close plan"
            onClick={props.onBack}
            className="-mr-3 shrink-0 text-fg"
          >
            <IconX size={ICON_SIZE.control} />
          </IconButton>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
        <div className="flex flex-col gap-3.5 p-4">
          <section aria-label="Files" className="flex flex-col gap-2">
            <h4 className={SECTION_LABEL}>Files</h4>
            {concept.image !== null ? (
              <div className="grid grid-cols-3 gap-1.5">
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg border bg-panel-3 text-fg-3 lit-card-muted">
                    <IconImage size={ICON_SIZE.tray} />
                  </span>
                  <span className="block w-full truncate text-sm text-fg-3">{concept.image}</span>
                </span>
              </div>
            ) : (
              <div className="flex h-[120px] items-center justify-center rounded-lg border border-dashed border-border-strong bg-panel text-md text-fg-3">
                No files
              </div>
            )}
          </section>

          <div className="flex flex-col gap-1.5 rounded-lg border bg-panel p-3 lit-card">
            <h3 className="min-w-0 break-words pt-2.5 text-lg font-semibold text-fg">
              {concept.title}
            </h3>
            <p className="whitespace-pre-wrap break-words text-base text-fg-2">
              {concept.description}
            </p>
          </div>

          <div
            data-plan-status=""
            className="flex flex-col gap-1.5 rounded-lg border bg-panel p-3 lit-card"
          >
            <div className="flex min-h-[28px] items-center justify-between gap-2">
              <span className="text-base text-fg-3">Date</span>
              <span className="font-mono text-md tabular-nums text-fg-2">
                {dayHeader(concept.day)}
              </span>
            </div>
            <div className="flex min-h-[28px] items-center justify-between gap-2">
              <span className="text-base text-fg-3">Approvers</span>
              <StatusPill status={concept.plan} />
            </div>
            {linked === null ? (
              <div data-proto-status-post="none" className="flex min-h-[28px] items-center justify-between gap-2">
                <span className="text-base text-fg-3">Post</span>
                <span className="text-md text-fg-2">{POST_NOT_MADE_LABEL}</span>
              </div>
            ) : (
              <PressableRow
                type="button"
                data-proto-status-post={linked.id}
                onClick={props.onOpenPost}
                className="-mx-2 flex items-center justify-between gap-2 px-2"
              >
                <span className="shrink-0 text-base text-fg-3">Post</span>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-md text-fg">
                    {locked ? DRAFT_NOT_READY : linked.title}
                  </span>
                  {locked ? null : <Tag label={postLine(linked.stage).label} dot={linked.stage} />}
                  <span className="shrink-0 text-fg-3">
                    <IconChevronRight size={ICON_SIZE.inline} />
                  </span>
                </span>
              </PressableRow>
            )}
          </div>

          {agency && concept.plan === 'approved' && linked === null ? (
            <Button
              variant="link"
              data-proto-link=""
              onClick={props.onLink}
              className="w-full bg-accent-soft"
            >
              <IconLink size={ICON_SIZE.inline} />
              Link a post
            </Button>
          ) : null}
          {agency && linked !== null ? (
            <div className="grid grid-cols-2 gap-2">
              <Button data-proto-change="" onClick={props.onLink}>
                Change linked post
              </Button>
              <Button data-proto-unlink="" onClick={props.onUnlink}>
                <span className="text-bad">Unlink post</span>
              </Button>
            </div>
          ) : null}

          <section className="flex flex-col gap-2.5" aria-label="Comments">
            <h4 className={SECTION_LABEL}>Comments</h4>
            {concept.comments.length === 0 ? (
              <p className="text-md text-fg-3">Comments show up here.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {concept.comments.map((c) => (
                  <li key={c.id} className="flex items-start gap-2.5">
                    <span
                      aria-hidden="true"
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-panel-3 text-sm font-semibold text-fg-2 lit-avatar"
                    >
                      {c.author.charAt(0)}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex items-baseline gap-2">
                        <span className="text-md font-semibold text-fg">{c.author}</span>
                        <span className="font-mono text-sm tabular-nums text-fg-3">{c.time}</span>
                      </div>
                      <p className="w-fit max-w-full rounded-xl bg-panel-2 px-3 py-2 text-base text-fg lit-card-muted">
                        {c.body}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
