// A message body as text runs and links: chat bubbles (MessageThread) and the
// Plan item screen's concept description render through this one function, so
// a link looks and opens the same everywhere. Moved out of MessageThread.tsx
// unchanged, so screens that show a body never import the thread.

import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { parseFormat, type FormatStyle } from '@srtdio/comments';
import { UnsafeLinkText } from '@/components/ui/UnsafeLinkSheet';
import { highlightNodes } from '@/components/ui/SearchHighlight';
import { cn } from '@/lib/cn';
import {
  APP_ENTITY_ROUTES,
  classify,
  currentOrigin,
  displayUrl,
  tokenize,
} from '@/lib/chat/message-links';
import { checkLink } from '@/lib/links/safety';

/** Link ink per side: accent on a peer bubble, accent-fg on the solid own bubble. */
export function bodyLinkClass(mine: boolean): string {
  return cn('underline', mine ? 'text-accent-fg' : 'text-accent');
}

/** The element each display style draws with. Underline keeps the body
 *  colour, so it never reads as a link (links are accent + underline). */
function wrapStyle(style: Exclude<FormatStyle, 'mono'>, node: ReactNode): ReactNode {
  switch (style) {
    case 'bold':
      return <strong className="font-semibold">{node}</strong>;
    case 'italic':
      return <em className="italic">{node}</em>;
    case 'strike':
      return <s className="line-through">{node}</s>;
    case 'underline':
      return <u className="underline decoration-current">{node}</u>;
  }
}

/** Mono: the same size, the mono face, a faint fill (on-bubble inside the own bubble). */
export const FORMAT_MONO_CLASS = 'rounded-sm bg-panel-2 font-mono';

/**
 * Saved free text with WhatsApp formatting as the OUTER layer: each styled
 * segment from parseFormat is wrapped in <strong>/<em>/<s>/<u>, and `inner`
 * renders its text (links, mentions, search marks). Mono is literal: its raw
 * text in <code>, never passed to `inner`. A body with no formatting returns
 * exactly `inner(body)`, so plain bodies render as before.
 */
export function renderFormatted(body: string, inner: (text: string) => ReactNode[]): ReactNode[] {
  const segments = parseFormat(body);
  const only = segments[0];
  if (segments.length === 0) return [];
  if (segments.length === 1 && only !== undefined && only.styles.length === 0) {
    return inner(only.text);
  }
  return segments.map((segment, i) => {
    const mono = segment.styles.includes('mono');
    let node: ReactNode = mono ? (
      <code className={FORMAT_MONO_CLASS}>{segment.text}</code>
    ) : (
      <>{inner(segment.text)}</>
    );
    for (let k = segment.styles.length - 1; k >= 0; k -= 1) {
      const style = segment.styles[k];
      if (style !== undefined && style !== 'mono') node = wrapStyle(style, node);
    }
    return <Fragment key={i}>{node}</Fragment>;
  });
}

/**
 * A message body with WhatsApp formatting, then text runs and links inside
 * each styled segment (renderBodyLinks). Every saved-text surface that shows a
 * chat body renders through here.
 */
export function renderMessageBody(
  body: string,
  mine: boolean,
  origin: string | null = currentOrigin(),
  highlight: readonly string[] = [],
): ReactNode[] {
  return renderFormatted(body, (text) => renderBodyLinks(text, mine, origin, highlight));
}

/**
 * A message body as text runs and links. External urls open in a new tab and
 * show without the scheme; links to this app's own post or brief pages are
 * router links that open in-app. The whole link text is the tap target. Pure:
 * the origin is read at call time, so the first paint is final.
 */
export function renderBodyLinks(
  body: string,
  mine: boolean,
  origin: string | null = currentOrigin(),
  highlight: readonly string[] = [],
): ReactNode[] {
  const className = bodyLinkClass(mine);
  return tokenize(body).map((segment, i) => {
    if (segment.kind === 'text') {
      return highlight.length === 0 ? (
        segment.text
      ) : (
        <Fragment key={i}>{markSearchWords(segment.text, highlight)}</Fragment>
      );
    }
    const target = classify(segment.url, origin, APP_ENTITY_ROUTES);
    const label = displayUrl(segment.url);
    // An unsafe link opens the check sheet, never the site (its card warns too).
    const verdict = target.kind === 'external' ? checkLink(segment.url) : null;
    if (verdict !== null && verdict.verdict === 'unsafe') {
      return (
        <UnsafeLinkText
          key={i}
          url={segment.url}
          reasons={verdict.reasons}
          className={cn('inline', className)}
          msgLink
        >
          {label}
        </UnsafeLinkText>
      );
    }
    return target.kind === 'external' ? (
      <a
        key={i}
        data-msg-link=""
        href={segment.url}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
      >
        {label}
      </a>
    ) : (
      <Link key={i} data-msg-link="" to={target.path} className={className}>
        {label}
      </Link>
    );
  });
}

/** A searched word in a bubble: the shared search highlight (SearchHighlight.tsx). */
export const markSearchWords = highlightNodes;
