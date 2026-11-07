// The preview card for an external link (approved prototype, 17 Oct).
//
// Types: full (picture + favicon letter + domain + title + description, play
// badge and duration on video pages), text (title, no picture), login ("Sign-in
// needed to preview"), bare (domain + path), unsafe (warning card that opens
// UnsafeLinkSheet; never fetched), plus a skeleton.
//
// Sizes:
//   'full'    chat bubbles, comments, briefs. A 1.91:1 picture box over a body
//             with fixed line slots, ONLY when there is a picture to show.
//   'compact' tight spots (brief cards, the chat Links tab): one 64px row.
//   'draft'   the composer card above the input, with a "Clear" button.
//
// No picture, no picture box: a 'full' card whose answer has no picture
// (text, login, bare, unsafe, or a picture that fails to load) is the compact
// row (letter tile, title, domain), never an empty 1.91:1 slot. A card waiting
// for its answer shows the tall skeleton (most shared links carry a picture);
// when the answer has none it settles to the compact row. A card whose answer
// is known at first paint (session cache, unsafe, no Worker URL) uses its final
// layout directly.
//
// Type comes from ui/Text roles only (heading for titles, secondary for the
// domain or path); paths are never mono.
//
// Remote text is rendered as React text nodes only; there is no HTML sink here.
// Every external anchor opens a new tab with rel="noopener noreferrer". Colours
// are tokens only (incoming, outgoing-on-accent and plain surfaces), so light
// and dark parity comes from the theme.

import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { IconAlertTriangle, IconPlay, ICON_SIZE } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { UnsafeLinkSheet } from '@/components/ui/UnsafeLinkSheet';
import { cn } from '@/lib/cn';
import { Bone } from '@/lib/motion';
import { useInView } from '@/lib/use-in-view';
import {
  PREVIEW_ROOT_MARGIN,
  previewClient,
  type LinkPreview,
  type PreviewClient,
} from '@/lib/links/preview';

export type CardTone = 'in' | 'out' | 'plain';
type CardSize = 'full' | 'compact' | 'draft';

interface LinkPreviewCardProps {
  url: string;
  /** Surface: an incoming bubble, an outgoing (accent) bubble, or a page. */
  tone?: CardTone;
  size?: CardSize;
  /** Draft only: the "Clear" button. Removes the card for this message; the link still sends. */
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

/** A real card lifts: lit-card draws its edges, so the neutral border colour goes. */
const CARD_SURFACE: Record<CardTone, string> = {
  in: 'bg-panel text-fg',
  out: 'border-overlay-line bg-overlay-surface text-inherit',
  plain: 'bg-panel-2 text-fg',
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

const WARN = 'border-warn-line bg-warn-soft text-warn-ink';

/** Shared guard: no iOS text selection or callout on long-press over a card. */
const NO_CALLOUT = 'select-none [-webkit-touch-callout:none]';

const FOCUS = 'focus-visible:lit-focus';

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

  useEffect(() => {
    if (preview !== null || !enabled) return;
    const controller = new AbortController();
    client.request(url, controller.signal).then(setPreview, () => undefined);
    return () => controller.abort();
  }, [client, enabled, preview, url]);

  return preview;
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

/** The 1.91:1 picture slot. Only drawn when there is a picture; a failed load collapses the card. */
function MediaSlot(props: {
  tone: CardTone;
  src: string;
  video: boolean;
  onError: () => void;
}): ReactElement {
  return (
    <div
      data-card-media=""
      className={cn('relative aspect-[1.91/1] w-full overflow-hidden', MEDIA_BG[props.tone])}
    >
      <img
        src={props.src}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        draggable={false}
        onError={props.onError}
        className="absolute inset-0 h-full w-full object-cover"
      />
      {props.video ? (
        <span className="absolute inset-0 grid place-items-center">
          <span className="grid h-11 w-11 place-items-center rounded-full bg-overlay-badge pl-0.5 lit-media text-overlay-fg">
            <IconPlay size={ICON_SIZE.nav} />
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
    <div className="flex min-w-0 flex-col gap-0.5 px-3 pb-2 pt-2">
      <div className="flex h-4 min-w-0 items-center gap-2 text-sm text-fg-3">
        <LetterTile letter={props.letter} tone={props.tone} className="size-4 rounded text-xs" />
        <span className="min-w-0 truncate">{props.site}</span>
      </div>
      <Text role="heading" as="div" className="line-clamp-2 h-10">
        {props.title}
      </Text>
      <div className="line-clamp-2 h-8 text-sm text-fg-2">{props.detail}</div>
    </div>
  );
}

// Loading bars are the shared Bone (a top-lit sweep, never a pulse).
function SkeletonBar(props: { className: string }): ReactElement {
  return <Bone lit="flat" className={cn('rounded', props.className)} />;
}

function TallSkeleton(props: { tone: CardTone }): ReactElement {
  return (
    <div
      data-card-type="skeleton"
      aria-hidden="true"
      className={cn('rounded-xl border lit-card', CARD_SURFACE[props.tone])}
    >
      <Bone lit="flat" as="div" className="aspect-[1.91/1] w-full rounded-t-xl" />
      <div className="flex flex-col gap-0.5 px-3 pb-2 pt-2">
        <div className="flex h-4 items-center">
          <SkeletonBar className="h-2 w-24" />
        </div>
        <div className="flex h-10 flex-col justify-center gap-2">
          <SkeletonBar className="h-3 w-full" />
          <SkeletonBar className="h-3 w-2/3" />
        </div>
        <div className="flex h-8 flex-col justify-center">
          <SkeletonBar className="h-2 w-4/5" />
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
      className={cn(
        'flex h-16 items-center gap-3 rounded-xl border px-3 lit-card',
        CARD_SURFACE[props.tone],
      )}
    >
      <SkeletonBar className="h-10 w-10 shrink-0 rounded-xl" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <SkeletonBar className="h-3 w-2/3" />
        <SkeletonBar className="h-2 w-1/2" />
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
        'block overflow-hidden rounded-xl border no-underline lit-card',
        NO_CALLOUT,
        FOCUS,
        props.className,
      )}
    >
      {props.children}
    </a>
  );
}

type TitledPreview = Extract<LinkPreview, { type: 'full' | 'text' }>;

/** The tall card: only for a preview with a picture to show. */
function Tall(props: {
  url: string;
  preview: TitledPreview;
  tone: CardTone;
  imageSrc: string;
  onImageError: () => void;
}): ReactElement {
  const { preview, tone } = props;
  const site = siteText(preview);
  const duration =
    preview.durationSeconds !== null ? ` · ${formatDuration(preview.durationSeconds)}` : '';
  return (
    <CardLink
      url={props.url}
      label={cardLabel(preview)}
      type={preview.type}
      className={CARD_SURFACE[tone]}
    >
      <MediaSlot
        tone={tone}
        src={props.imageSrc}
        video={preview.video}
        onError={props.onImageError}
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

/**
 * The 64px row: letter tile, title, domain (or path). Every answer without a
 * picture uses it, at every size, so there is never an empty picture box.
 */
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
          'flex h-16 w-full items-center gap-3 rounded-xl border px-3 text-left lit-card',
          WARN,
          NO_CALLOUT,
          FOCUS,
        )}
      >
        <IconAlertTriangle size={ICON_SIZE.control} className="shrink-0" />
        <span className="flex min-w-0 flex-col">
          <Text role="heading" className="truncate">
            This link may be unsafe
          </Text>
          <Text role="body" className="truncate">{`${preview.domain} · tap to check`}</Text>
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
      className={cn('flex h-16 items-center gap-3 px-3', CARD_SURFACE[tone])}
    >
      <LetterTile letter={preview.letter} tone={tone} className="h-10 w-10 rounded-xl text-base" />
      <span className="flex min-w-0 flex-col">
        <Text role="heading" className="truncate">
          {titled ? preview.title : preview.domain}
        </Text>
        {via ? (
          <Text role="secondary">{siteText(preview)}</Text>
        ) : titled ? (
          <Text role="secondary">{preview.domain}</Text>
        ) : preview.path !== '' ? (
          <Text role="secondary">{preview.path}</Text>
        ) : null}
        {preview.type === 'login' ? (
          <Text role="secondary">Sign-in needed to preview</Text>
        ) : null}
      </span>
    </CardLink>
  );
}

/** The composer's draft card: thumb, two lines, Clear. Not a link (the draft is not sent yet). */
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
    thumb = <SkeletonBar className="h-12 w-12 shrink-0 rounded-lg" />;
    lines = (
      <span className="flex flex-col gap-2">
        <SkeletonBar className="h-2 w-24" />
        <SkeletonBar className="h-3 w-40" />
      </span>
    );
  } else if (preview.type === 'unsafe') {
    thumb = (
      <span className="grid h-12 w-12 shrink-0 place-items-center">
        <IconAlertTriangle size={ICON_SIZE.tray} />
      </span>
    );
    lines = (
      <>
        <Text role="heading" className="block truncate">
          This link may be unsafe
        </Text>
        <Text role="body" className="block truncate">
          {preview.domain}
        </Text>
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
          className="h-12 w-12 shrink-0 rounded-lg bg-panel-3 object-cover"
        />
      ) : (
        <LetterTile letter={preview.letter} tone="plain" className="h-12 w-12 rounded-lg text-lg" />
      );
    const titled = preview.type === 'full' || preview.type === 'text';
    lines = (
      <>
        <Text role="secondary" className="block">
          {siteText(preview)}
        </Text>
        <Text role="heading" className="block truncate">
          {titled
            ? preview.title
            : preview.type === 'login'
              ? 'Sign-in needed to preview'
              : preview.path || preview.domain}
        </Text>
      </>
    );
  }
  return (
    <div
      data-card-type={preview === null ? 'skeleton' : preview.type}
      data-card-size="draft"
      className={cn(
        'flex h-16 items-center gap-2 rounded-xl border py-1 pl-2 pr-0',
        warn ? `${WARN} lit-tint` : 'bg-panel-2 text-fg lit-card-muted',
        NO_CALLOUT,
      )}
    >
      {thumb}
      <span className="min-w-0 flex-1">{lines}</span>
      {props.onRemove !== undefined ? (
        <Button
          type="button"
          variant="ghost"
          aria-label="Remove link preview"
          data-card-remove=""
          onClick={props.onRemove}
          className="shrink-0"
        >
          Clear
        </Button>
      ) : null}
    </div>
  );
}

export function LinkPreviewCard(props: LinkPreviewCardProps): ReactElement {
  const tone = props.tone ?? 'plain';
  const size = props.size ?? 'full';
  const client = props.client ?? previewClient();
  const { ref, inView } = useInView<HTMLDivElement>(PREVIEW_ROOT_MARGIN);
  const preview = useLinkPreview(props.url, client, inView);
  const [sheetOpen, setSheetOpen] = useState(false);
  // A picture that fails to load collapses the card to the compact row.
  const [imageFailed, setImageFailed] = useState(false);
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
  } else if (preview.type === 'full' && imageSrc !== null && !imageFailed) {
    body = (
      <Tall
        url={props.url}
        preview={preview}
        tone={tone}
        imageSrc={imageSrc}
        onImageError={() => setImageFailed(true)}
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
