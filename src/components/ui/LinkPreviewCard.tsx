// The preview card for an external link (approved prototype, 17 Oct).
//
// Types: full (picture + favicon letter + domain + title + description, play
// badge and duration on video pages), text (title, no picture), login ("Sign-in
// needed to preview"), bare (domain + path), unsafe (warning card that opens
// UnsafeLinkSheet; never fetched), plus a skeleton of the same size.
//
// Sizes:
//   'full'    chat bubbles, comments, briefs. 1.91:1 picture box over a body
//             with fixed line slots.
//   'compact' tight spots (brief cards, the chat Links tab): one 64px row.
//   'draft'   the composer card above the input, with an X.
//
// Reserved space: every layout has fixed dimensions, and the skeleton is the
// same box. When a 'full' card first paints as a skeleton, it HOLDS that box for
// its lifetime: a text/login/bare/unsafe answer is drawn inside the held box
// (letter tile in the picture slot) instead of collapsing to the compact row,
// so nothing below it moves. A card whose answer is known at first paint
// (session cache, unsafe, no Worker URL) uses its natural layout directly. A
// picture that fails to load turns into the letter tile inside the same box.
//
// Remote text is rendered as React text nodes only; there is no HTML sink here.
// Every external anchor opens a new tab with rel="noopener noreferrer". Colours
// are tokens only (incoming, outgoing-on-accent and plain surfaces), so light
// and dark parity comes from the theme.

import { useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { IconAlertTriangle, IconPlay, IconX } from '@/components/ui/icons';
import { UnsafeLinkSheet } from '@/components/ui/UnsafeLinkSheet';
import { cn } from '@/lib/cn';
import { useInView } from '@/lib/use-in-view';
import {
  PREVIEW_ROOT_MARGIN,
  previewClient,
  type LinkPreview,
  type PreviewClient,
} from '@/lib/links/preview';

export type CardTone = 'in' | 'out' | 'plain';
export type CardSize = 'full' | 'compact' | 'draft';

export interface LinkPreviewCardProps {
  url: string;
  /** Surface: an incoming bubble, an outgoing (accent) bubble, or a page. */
  tone?: CardTone;
  size?: CardSize;
  /** Draft only: the X. Removes the card for this message; the link still sends. */
  onRemove?: () => void;
  /** Layout-only classes for the outer box (width, margins). */
  className?: string;
  /** Tests inject a client; the app uses the shared one. */
  client?: PreviewClient;
}

/** 134 -> "2:14", 3723 -> "1:02:03". */
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const SURFACE: Record<CardTone, string> = {
  in: 'border-border bg-panel text-fg',
  out: 'border-overlay-line bg-overlay-surface text-inherit',
  plain: 'border-border bg-panel-2 text-fg',
};

const MEDIA_BG: Record<CardTone, string> = {
  in: 'bg-panel-3',
  out: 'bg-overlay-surface',
  plain: 'bg-panel-3',
};

const TILE: Record<CardTone, string> = {
  in: 'bg-accent text-accent-fg',
  out: 'bg-accent-fg text-accent',
  plain: 'bg-accent text-accent-fg',
};

const WARN = 'border-[color:var(--warn-line)] bg-warn-soft text-[color:var(--warn-ink)]';

/** Shared guard: no iOS text selection or callout on long-press over a card. */
const NO_CALLOUT = 'select-none [-webkit-touch-callout:none]';

const FOCUS = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent';

/** The site row's text: "bit.ly → canva.com" for shorteners, else the domain. */
function siteText(p: { domain: string; finalDomain: string | null; viaShortener: string | null }) {
  return p.viaShortener !== null && p.finalDomain !== null
    ? `${p.viaShortener} → ${p.finalDomain}`
    : p.domain;
}

function cardLabel(preview: LinkPreview): string {
  if (preview.type === 'unsafe') return `This link may be unsafe, ${preview.domain}. Tap to check`;
  const site = preview.finalDomain ?? preview.domain;
  if (preview.type === 'full' || preview.type === 'text') {
    return `${preview.title}, ${site}. Opens in a new tab`;
  }
  return preview.type === 'login'
    ? `${preview.domain}, sign-in needed to preview. Opens in a new tab`
    : `${preview.domain}. Opens in a new tab`;
}

/** The preview for one card: synchronous when known, else fetched once in view. */
function useLinkPreview(url: string, client: PreviewClient, enabled: boolean) {
  const [preview, setPreview] = useState<LinkPreview | null>(() => client.peek(url));
  // Whether this card painted a skeleton first: it then keeps that box.
  const held = useRef(preview === null);

  useEffect(() => {
    if (preview !== null || !enabled) return;
    const controller = new AbortController();
    client.request(url, controller.signal).then(setPreview, () => undefined);
    return () => controller.abort();
  }, [client, enabled, preview, url]);

  return { preview, held: held.current };
}

function LetterTile(props: { letter: string; tone: CardTone; className: string }): ReactElement {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid shrink-0 place-items-center font-semibold',
        TILE[props.tone],
        props.className,
      )}
    >
      {props.letter}
    </span>
  );
}

/** The 1.91:1 picture slot: image, or the letter tile when there is none / it failed. */
function MediaSlot(props: {
  tone: CardTone;
  letter: string;
  src: string | null;
  video: boolean;
  warn?: boolean;
}): ReactElement {
  const [failed, setFailed] = useState(false);
  const showImage = props.src !== null && !failed;
  return (
    <div
      data-card-media=""
      className={cn(
        'relative aspect-[1.91/1] w-full overflow-hidden',
        props.warn === true ? 'bg-warn-soft' : MEDIA_BG[props.tone],
      )}
    >
      {props.warn === true ? (
        <span className="absolute inset-0 grid place-items-center text-[color:var(--warn-ink)]">
          <IconAlertTriangle size={36} />
        </span>
      ) : showImage && props.src !== null ? (
        <img
          src={props.src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <span className="absolute inset-0 grid place-items-center">
          <LetterTile
            letter={props.letter}
            tone={props.tone}
            className="h-14 w-14 rounded-2xl text-3xl"
          />
        </span>
      )}
      {props.video ? (
        <span className="absolute inset-0 grid place-items-center">
          <span className="grid h-11 w-11 place-items-center rounded-full bg-[color:var(--media-meta-bg)] pl-0.5 text-[color:var(--media-meta-fg)]">
            <IconPlay size={18} />
          </span>
        </span>
      ) : null}
    </div>
  );
}

/** Body of the tall card: site row (16px), title slot (2 lines), detail slot (2 lines). */
function TallBody(props: {
  tone: CardTone;
  letter: string;
  site: ReactNode;
  title: ReactNode;
  detail: ReactNode;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-2.5 pb-[9px] pt-2">
      <div className="flex h-4 min-w-0 items-center gap-1.5 text-xs leading-4 opacity-75">
        <LetterTile
          letter={props.letter}
          tone={props.tone}
          className="h-3.5 w-3.5 rounded text-xs"
        />
        <span className="min-w-0 truncate">{props.site}</span>
      </div>
      <div className="line-clamp-2 h-9 text-base font-semibold">
        {props.title}
      </div>
      <div className="line-clamp-2 h-8 text-sm leading-4 opacity-80">{props.detail}</div>
    </div>
  );
}

function SkeletonBar(props: { className: string }): ReactElement {
  return (
    <span className={cn('block rounded bg-panel-3 motion-safe:animate-pulse', props.className)} />
  );
}

function TallSkeleton(props: { tone: CardTone }): ReactElement {
  return (
    <div
      data-card-type="skeleton"
      aria-hidden="true"
      className={cn('rounded-xl border', SURFACE[props.tone])}
    >
      <div
        className={cn(
          'aspect-[1.91/1] w-full rounded-t-xl',
          MEDIA_BG[props.tone],
          'motion-safe:animate-pulse',
        )}
      />
      <div className="flex flex-col gap-0.5 px-2.5 pb-[9px] pt-2">
        <div className="flex h-4 items-center">
          <SkeletonBar className="h-2.5 w-24" />
        </div>
        <div className="flex h-9 flex-col justify-center gap-1.5">
          <SkeletonBar className="h-3 w-full" />
          <SkeletonBar className="h-3 w-2/3" />
        </div>
        <div className="flex h-8 flex-col justify-center">
          <SkeletonBar className="h-2.5 w-4/5" />
        </div>
      </div>
    </div>
  );
}

function CompactSkeleton(props: { tone: CardTone }): ReactElement {
  return (
    <div
      data-card-type="skeleton"
      aria-hidden="true"
      className={cn('flex h-16 items-center gap-2.5 rounded-xl border px-2.5', SURFACE[props.tone])}
    >
      <SkeletonBar className="h-10 w-10 shrink-0 rounded-xl" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <SkeletonBar className="h-3 w-2/3" />
        <SkeletonBar className="h-2.5 w-1/2" />
      </div>
    </div>
  );
}

/** One external anchor; the whole card is the tap target (>= 44px tall). */
function CardLink(props: {
  url: string;
  label: string;
  type: string;
  className: string;
  children: ReactNode;
}): ReactElement {
  return (
    <a
      href={props.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={props.label}
      data-card-type={props.type}
      draggable={false}
      className={cn(
        'block overflow-hidden rounded-xl border no-underline',
        NO_CALLOUT,
        FOCUS,
        props.className,
      )}
    >
      {props.children}
    </a>
  );
}

function Tall(props: {
  url: string;
  preview: LinkPreview;
  tone: CardTone;
  imageSrc: string | null;
  onUnsafe: () => void;
}): ReactElement {
  const { preview, tone } = props;
  if (preview.type === 'unsafe') {
    return (
      <button
        type="button"
        onClick={props.onUnsafe}
        aria-label={cardLabel(preview)}
        data-card-type="unsafe"
        className={cn(
          'block w-full overflow-hidden rounded-xl border text-left',
          WARN,
          NO_CALLOUT,
          FOCUS,
        )}
      >
        <MediaSlot tone={tone} letter="!" src={null} video={false} warn />
        <TallBody
          tone={tone}
          letter="!"
          site={preview.domain}
          title="This link may be unsafe"
          detail={`${preview.domain} · tap to check`}
        />
      </button>
    );
  }
  const site = siteText(preview);
  if (preview.type === 'full' || preview.type === 'text') {
    const duration =
      preview.durationSeconds !== null ? ` · ${formatDuration(preview.durationSeconds)}` : '';
    return (
      <CardLink
        url={props.url}
        label={cardLabel(preview)}
        type={preview.type}
        className={SURFACE[tone]}
      >
        <MediaSlot
          tone={tone}
          letter={preview.letter}
          src={preview.type === 'full' ? props.imageSrc : null}
          video={preview.video}
        />
        <TallBody
          tone={tone}
          letter={preview.letter}
          site={`${site}${duration}`}
          title={preview.title}
          detail={preview.description ?? ''}
        />
      </CardLink>
    );
  }
  return (
    <CardLink
      url={props.url}
      label={cardLabel(preview)}
      type={preview.type}
      className={SURFACE[tone]}
    >
      <MediaSlot tone={tone} letter={preview.letter} src={null} video={false} />
      <TallBody
        tone={tone}
        letter={preview.letter}
        site={site}
        title={
          preview.path !== '' ? (
            <span className="break-all font-mono text-sm font-normal opacity-80">
              {preview.path}
            </span>
          ) : (
            preview.domain
          )
        }
        detail={preview.type === 'login' ? 'Sign-in needed to preview' : ''}
      />
    </CardLink>
  );
}

/** The 64px row: big letter tile + up to three short lines. */
function Compact(props: {
  url: string;
  preview: LinkPreview;
  tone: CardTone;
  onUnsafe: () => void;
}) {
  const { preview, tone } = props;
  if (preview.type === 'unsafe') {
    return (
      <button
        type="button"
        onClick={props.onUnsafe}
        aria-label={cardLabel(preview)}
        data-card-type="unsafe"
        className={cn(
          'flex h-16 w-full items-center gap-2.5 rounded-xl border px-2.5 text-left',
          WARN,
          NO_CALLOUT,
          FOCUS,
        )}
      >
        <IconAlertTriangle size={20} className="shrink-0" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-md font-semibold">
            This link may be unsafe
          </span>
          <span className="truncate text-sm leading-4 opacity-90">{`${preview.domain} · tap to check`}</span>
        </span>
      </button>
    );
  }
  const titled = preview.type === 'full' || preview.type === 'text';
  const via = preview.viaShortener !== null && preview.finalDomain !== null;
  return (
    <CardLink
      url={props.url}
      label={cardLabel(preview)}
      type={preview.type}
      className={cn('flex h-16 items-center gap-2.5 px-2.5', SURFACE[tone])}
    >
      <LetterTile
        letter={preview.letter}
        tone={tone}
        className="h-10 w-10 rounded-xl text-base"
      />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-md font-semibold">
          {titled ? preview.title : preview.domain}
        </span>
        {via ? (
          <span className="truncate font-mono text-xs opacity-70">
            {siteText(preview)}
          </span>
        ) : titled ? (
          <span className="truncate text-xs opacity-75">{preview.domain}</span>
        ) : preview.path !== '' ? (
          <span className="truncate font-mono text-xs opacity-70">
            {preview.path}
          </span>
        ) : null}
        {preview.type === 'login' ? (
          <span className="truncate text-xs opacity-75">
            Sign-in needed to preview
          </span>
        ) : null}
      </span>
    </CardLink>
  );
}

/** The composer's draft card: thumb, two lines, X. Not a link (the draft is not sent yet). */
function Draft(props: {
  preview: LinkPreview | null;
  imageSrc: string | null;
  onRemove?: (() => void) | undefined;
}): ReactElement {
  const { preview } = props;
  const [failed, setFailed] = useState(false);
  const warn = preview?.type === 'unsafe';
  let thumb: ReactNode;
  let lines: ReactNode;
  if (preview === null) {
    thumb = <SkeletonBar className="h-[52px] w-[52px] shrink-0 rounded-lg" />;
    lines = (
      <span className="flex flex-col gap-1.5">
        <SkeletonBar className="h-2.5 w-24" />
        <SkeletonBar className="h-3 w-40" />
      </span>
    );
  } else if (preview.type === 'unsafe') {
    thumb = (
      <span className="grid h-[52px] w-[52px] shrink-0 place-items-center">
        <IconAlertTriangle size={22} />
      </span>
    );
    lines = (
      <>
        <span className="block truncate text-md font-semibold leading-4">
          This link may be unsafe
        </span>
        <span className="block truncate text-sm leading-4 opacity-90">{preview.domain}</span>
      </>
    );
  } else {
    const src = preview.type === 'full' && !failed ? props.imageSrc : null;
    thumb =
      src !== null ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setFailed(true)}
          className="h-[52px] w-[52px] shrink-0 rounded-lg bg-panel-3 object-cover"
        />
      ) : (
        <LetterTile
          letter={preview.letter}
          tone="plain"
          className="h-[52px] w-[52px] rounded-lg text-lg"
        />
      );
    const titled = preview.type === 'full' || preview.type === 'text';
    lines = (
      <>
        <span className="block truncate text-xs leading-4 opacity-75">
          {siteText(preview)}
        </span>
        <span className="line-clamp-2 text-md font-semibold leading-4">
          {titled
            ? preview.title
            : preview.type === 'login'
              ? 'Sign-in needed to preview'
              : preview.path || preview.domain}
        </span>
      </>
    );
  }
  return (
    <div
      data-card-type={preview === null ? 'skeleton' : preview.type}
      data-card-size="draft"
      className={cn(
        'flex h-16 items-center gap-2 rounded-xl border py-1.5 pl-2 pr-0',
        warn ? WARN : 'border-border bg-panel-2 text-fg',
        NO_CALLOUT,
      )}
    >
      {thumb}
      <span className="min-w-0 flex-1">{lines}</span>
      {props.onRemove !== undefined ? (
        <button
          type="button"
          aria-label="Remove preview"
          data-card-remove=""
          onClick={props.onRemove}
          className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl text-fg-2', FOCUS)}
        >
          <IconX size={18} />
        </button>
      ) : null}
    </div>
  );
}

export function LinkPreviewCard(props: LinkPreviewCardProps): ReactElement {
  const tone = props.tone ?? 'plain';
  const size = props.size ?? 'full';
  const client = props.client ?? previewClient();
  const { ref, inView } = useInView<HTMLDivElement>(PREVIEW_ROOT_MARGIN);
  const { preview, held } = useLinkPreview(props.url, client, inView);
  const [sheetOpen, setSheetOpen] = useState(false);
  const imageSrc = client.imageUrl(props.url);
  const openSheet = (): void => setSheetOpen(true);

  let body: ReactNode;
  if (size === 'draft') {
    body = <Draft preview={preview} imageSrc={imageSrc} onRemove={props.onRemove} />;
  } else if (size === 'compact') {
    body =
      preview === null ? (
        <CompactSkeleton tone={tone} />
      ) : (
        <Compact url={props.url} preview={preview} tone={tone} onUnsafe={openSheet} />
      );
  } else if (preview === null) {
    body = <TallSkeleton tone={tone} />;
  } else if (held || preview.type === 'full') {
    body = (
      <Tall
        url={props.url}
        preview={preview}
        tone={tone}
        imageSrc={imageSrc}
        onUnsafe={openSheet}
      />
    );
  } else {
    body = <Compact url={props.url} preview={preview} tone={tone} onUnsafe={openSheet} />;
  }

  return (
    <div
      ref={ref}
      data-link-card=""
      data-card-size={size}
      className={cn('min-w-0', props.className)}
    >
      {body}
      {preview?.type === 'unsafe' ? (
        <UnsafeLinkSheet
          open={sheetOpen}
          url={props.url}
          reasons={preview.reasons}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
    </div>
  );
}
