// The Plan screen's view mode, recreated from PlanScreen.tsx: the two-line
// header, the PLAN / POST progress boxes, then one block per day (the date
// tile on its first row). A concept with a linked post renders as one joined
// pair: the concept row unchanged (its POST line reads the post's stage), and
// under it the post row, indented behind a 2px accent line, with no PLAN line.
// A post already on the plan as its own row is hidden while it is paired.

import { Fragment } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { PressableRow } from '@/components/ui/PressableRow';
import {
  ICON_SIZE,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconLink,
  IconX,
} from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { ITEMS, PLAN, postById } from './fixtures';
import type {
  FixtureConcept,
  FixturePost,
  LinkState,
  PlanItem,
  ReviewStatus,
  Viewer,
} from './fixtures';
import {
  DRAFT_NOT_READY,
  DayTile,
  LINE_LABEL,
  PAIR_LABEL,
  PLAN_TEXT_TONES,
  PostLineView,
  RowTile,
  TileColumn,
  dueShort,
  planText,
} from './shared';

/** The rows a day shows: post items paired to a concept drop out (never twice). Pure. */
export function visibleItems(links: LinkState): PlanItem[] {
  const paired = new Set(Object.values(links).filter((v): v is string => v !== null));
  return ITEMS.filter((i) => i.kind === 'concept' || !paired.has(i.postId));
}

/**
 * Header counts with a pair counted once. PLAN: the visible rows' approvers OK
 * over the rows (a draft locked to a client is not one). POST: approved posts
 * over the post rows plus the pairs. Pure.
 */
export function planCounts(
  links: LinkState,
  viewer: Viewer,
): { plan: { ok: number; n: number }; post: { approved: number; n: number } } {
  const rows = visibleItems(links);
  const reviewed = rows.filter(
    (i) => !(viewer === 'client' && i.kind === 'post' && postById(i.postId)?.stage === 'draft'),
  );
  const ok = reviewed.filter((i) => i.plan === 'approved').length;
  const posts: FixturePost[] = [];
  for (const i of rows) {
    const p = i.kind === 'post' ? postById(i.postId) : postById(links[i.id] ?? null);
    if (p !== null) posts.push(p);
  }
  return {
    plan: { ok, n: reviewed.length },
    post: { approved: posts.filter((p) => p.stage === 'approved').length, n: posts.length },
  };
}

function days(): string[] {
  const out: string[] = [];
  const at = new Date(`${PLAN.startsOn}T00:00:00Z`);
  const end = new Date(`${PLAN.endsOn}T00:00:00Z`);
  while (at <= end) {
    out.push(at.toISOString().slice(0, 10));
    at.setUTCDate(at.getUTCDate() + 1);
  }
  return out;
}

export function PlanList(props: {
  links: LinkState;
  viewer: Viewer;
  laptop: boolean;
  openId: string | null;
  onOpenConcept: (id: string) => void;
  onOpenPost: (postId: string) => void;
}): ReactElement {
  const rows = visibleItems(props.links);
  const counts = planCounts(props.links, props.viewer);
  const boxes = [
    {
      key: 'plan',
      label: 'PLAN',
      text: `${counts.plan.ok}/${counts.plan.n} OK`,
      pct: counts.plan.n > 0 ? Math.round((counts.plan.ok / counts.plan.n) * 100) : 0,
      bar: 'bg-good',
    },
    {
      key: 'post',
      label: 'POST',
      text: `${counts.post.approved}/${counts.post.n} approved`,
      pct: counts.post.n > 0 ? Math.round((counts.post.approved / counts.post.n) * 100) : 0,
      bar: 'bg-accent',
    },
  ];
  return (
    <div data-proto-plan="" className="flex flex-col">
      <header className="relative z-20 flex shrink-0 flex-col gap-[2px] border-b bg-panel px-4 lit-header">
        <div className="flex min-h-[48px] items-center gap-2">
          <IconButton type="button" label="Back to chat" className="-ml-[11px] shrink-0 text-fg">
            <IconChevronLeft size={ICON_SIZE.control} />
          </IconButton>
          <h2 className="line-clamp-2 min-w-0 flex-1 break-normal text-3xl font-semibold tracking-tight text-fg">
            {PLAN.title}
          </h2>
          {props.laptop ? (
            <IconButton type="button" label="Close plan" className="-mr-3 shrink-0 text-fg">
              <IconX size={ICON_SIZE.control} />
            </IconButton>
          ) : null}
        </div>
        <div className="flex min-h-[44px] items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm text-fg-3">{PLAN.subtitle}</span>
        </div>
      </header>
      <div className="grid grid-cols-2 gap-2 px-4 pt-3">
        {boxes.map((box) => (
          <div
            key={box.key}
            data-proto-count={box.key}
            className="flex min-w-0 flex-col gap-1.5 rounded-xl bg-panel-2 p-3 lit-card-muted"
          >
            <span className="text-sm font-semibold uppercase tracking-[0.06em] text-fg-2">
              {box.label}
            </span>
            <span className="truncate font-mono text-md text-fg">{box.text}</span>
            <span className="block h-1 overflow-hidden rounded-full bg-panel-3 lit-well">
              <span className={cn('block h-1 lit-fill', box.bar)} style={{ width: `${box.pct}%` }} />
            </span>
          </div>
        ))}
      </div>
      <div className="flex flex-col pb-4 pt-3">
        {days().map((day) => {
          const items = rows.filter((i) => i.day === day);
          return (
            <div
              key={day}
              data-plan-day={day}
              className="flex flex-col gap-4 border-t border-border py-4 pl-4 pr-4"
            >
              {items.length === 0 ? (
                <div className="flex items-center">
                  <DayTile day={day} />
                  <p className="ml-3 flex min-h-[44px] items-center text-md text-fg-3">
                    Planned posts show up here.
                  </p>
                </div>
              ) : (
                items.map((item, index) => (
                  <Fragment key={item.id}>
                    <Row
                      item={item}
                      viewer={props.viewer}
                      first={index === 0}
                      linked={item.kind === 'concept' ? postById(props.links[item.id] ?? null) : null}
                      open={props.openId === item.id}
                      onOpenConcept={props.onOpenConcept}
                      onOpenPost={props.onOpenPost}
                    />
                  </Fragment>
                ))
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Row(props: {
  item: PlanItem;
  viewer: Viewer;
  first: boolean;
  linked: FixturePost | null;
  open: boolean;
  onOpenConcept: (id: string) => void;
  onOpenPost: (postId: string) => void;
}): ReactElement {
  const { item, viewer } = props;
  const tile = props.first ? (
    <DayTile day={item.day} />
  ) : (
    <span aria-hidden="true" className="w-14 shrink-0" />
  );
  if (item.kind === 'concept') {
    return (
      <div data-proto-row={item.id} className="flex w-full min-w-0 items-start gap-3">
        {tile}
        <div className="flex min-w-0 flex-1 flex-col">
          <PressableRow
            type="button"
            data-proto-open-concept={item.id}
            aria-current={props.open ? 'true' : undefined}
            onClick={() => props.onOpenConcept(item.id)}
            className={cn('flex min-w-0 items-start gap-3', props.open && 'bg-panel-2')}
          >
            <TitleBlock title={item.title} meta={item.description} />
            <TileColumn count={item.comments.length}>
              <RowTile kind={item.image !== null ? 'image' : 'concept'} />
            </TileColumn>
          </PressableRow>
          <div className="mt-1 flex flex-col">
            <PlanLine status={item.plan} viewer={viewer} title={item.title} />
            <PostLineView stage={props.linked?.stage ?? null} />
          </div>
          {props.linked !== null ? (
            <PairedPost
              concept={item}
              post={props.linked}
              viewer={viewer}
              onOpen={() => props.onOpenPost(props.linked?.id ?? '')}
            />
          ) : null}
        </div>
      </div>
    );
  }
  const post = postById(item.postId);
  if (post === null) return <></>;
  const locked = viewer === 'client' && post.stage === 'draft';
  return (
    <div data-proto-row={item.id} className="flex w-full min-w-0 items-start gap-3">
      {tile}
      <div className="flex min-w-0 flex-1 flex-col">
        <PressableRow
          type="button"
          data-proto-open-post={post.id}
          onClick={() => props.onOpenPost(post.id)}
          className="flex min-w-0 items-start gap-3"
        >
          <TitleBlock title={post.title} meta={locked ? DRAFT_NOT_READY : post.format} />
          <TileColumn count={0}>
            <RowTile kind={locked ? 'muted' : 'text'} />
          </TileColumn>
        </PressableRow>
        {locked ? null : (
          <div className="mt-1 flex flex-col">
            <PlanLine status={item.plan} viewer={viewer} title={post.title} />
            <PostLineView stage={post.stage} />
          </div>
        )}
      </div>
    </div>
  );
}

function TitleBlock(props: { title: string; meta: string; muted?: boolean }): ReactElement {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span
        className={cn(
          'line-clamp-2 break-words text-base font-medium',
          props.muted === true ? 'text-fg-2' : 'text-fg',
        )}
      >
        {props.title}
      </span>
      {props.meta !== '' ? <span className="truncate text-sm text-fg-3">{props.meta}</span> : null}
    </span>
  );
}

/**
 * The PLAN line on an Open plan: the agency reads it as text; a client gets
 * the decided pill (approved) or the OK | Not OK switch (inert in the mock).
 */
function PlanLine(props: { status: ReviewStatus; viewer: Viewer; title: string }): ReactElement {
  let control: ReactElement;
  if (props.viewer === 'agency') {
    control = (
      <span className={cn('text-md font-semibold', PLAN_TEXT_TONES[props.status])}>
        {planText(props.status)}
      </span>
    );
  } else if (props.status === 'approved') {
    control = (
      <Button variant="success" aria-label={`PLAN OK: ${props.title}`} className="shrink-0">
        <IconCheck size={ICON_SIZE.inline} />
        OK
        <span aria-hidden="true" className="opacity-70">
          <IconChevronDown size={ICON_SIZE.inline} />
        </span>
      </Button>
    );
  } else {
    control = (
      <span role="group" aria-label={`PLAN: ${props.title}`} className="flex shrink-0 items-center">
        <Button
          variant="ghost"
          className="min-w-[84px] rounded-r-none border border-border-strong bg-panel text-good lit-chip hover:text-good"
        >
          <IconCheck size={ICON_SIZE.inline} />
          OK
        </Button>
        <Button
          variant="ghost"
          className="-ml-px min-w-[84px] rounded-l-none border border-border-strong bg-panel text-bad lit-chip hover:text-bad"
        >
          <IconX size={ICON_SIZE.inline} />
          Not OK
        </Button>
      </span>
    );
  }
  return (
    <div data-plan-line="plan" className="flex min-h-[44px] items-center gap-3">
      <span className={LINE_LABEL}>PLAN</span>
      {control}
    </div>
  );
}

/** The linked post under its concept: indented, a 2px accent line, no PLAN line. */
function PairedPost(props: {
  concept: FixtureConcept;
  post: FixturePost;
  viewer: Viewer;
  onOpen: () => void;
}): ReactElement {
  const { post } = props;
  const locked = props.viewer === 'client' && post.stage === 'draft';
  const otherDate = post.dueDate !== props.concept.day;
  return (
    <div data-proto-pair={post.id} className="mt-2 flex flex-col border-l-2 border-accent pl-3">
      <PressableRow
        type="button"
        data-proto-open-pair={post.id}
        onClick={props.onOpen}
        className="flex min-w-0 items-start gap-3"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="inline-flex items-center gap-1 text-sm font-medium text-accent">
            <IconLink size={ICON_SIZE.inline} />
            {PAIR_LABEL}
          </span>
          <span
            className={cn(
              'line-clamp-2 break-words text-base font-medium',
              locked ? 'text-fg-2' : 'text-fg',
            )}
          >
            {post.title}
          </span>
          <span className="truncate text-sm text-fg-3">
            {locked ? DRAFT_NOT_READY : post.format}
            {!locked && otherDate ? (
              <>
                {' · '}
                <span data-proto-pair-date="" className="font-mono tabular-nums">
                  {dueShort(post.dueDate)}
                </span>
              </>
            ) : null}
          </span>
        </span>
        <TileColumn count={0}>
          <RowTile kind={locked ? 'muted' : 'text'} />
        </TileColumn>
      </PressableRow>
      {locked ? null : (
        <div className="mt-1">
          <PostLineView stage={post.stage} />
        </div>
      )}
    </div>
  );
}
