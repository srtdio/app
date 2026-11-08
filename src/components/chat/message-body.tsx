// A message body as text runs and links: chat bubbles (MessageThread) and the
// Plan item screen's concept description render through this one function, so
// a link looks and opens the same everywhere. Moved out of MessageThread.tsx
// unchanged, so screens that show a body never import the thread. renderRich
// adds the Slack blocks (numbered and bullet lists, quotes) as the outermost
// layer; a body with none renders exactly as before.

import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  hasBlocks,
  parseBlocks,
  parseFormat,
  splitLinks,
  type FormatStyle,
} from '@srtdio/comments';
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
    return <Fragment key={`part-${i}`}>{node}</Fragment>;
  });
}

/** What renders one styled segment's text (links, mentions, search marks). */
export type InnerRender = (text: string) => ReactNode[];

/** Space between a list or quote and the text around it (the 4 step). */
const BLOCK_GAP = 'my-1 first:mt-0 last:mb-0';
/** List markers sit in a 24 indent; the marker ink follows the text (currentColor). */
export const FORMAT_OL_CLASS = cn('list-decimal pl-6', BLOCK_GAP);
export const FORMAT_UL_CLASS = cn('list-disc pl-6', BLOCK_GAP);
/** Quote: a 3px bar in faded currentColor (index.css .fmt-quote); the text keeps full ink. */
export const FORMAT_QUOTE_CLASS = cn('fmt-quote pl-3', BLOCK_GAP);

/**
 * Saved free text with Slack blocks as the OUTER layer: consecutive "N. "
 * lines are an ordered list from the first N, "- " lines a bullet list, "> "
 * lines a quote; each paragraph, item and quote then renders through
 * renderFormatted with `inner`. A body with no block renders exactly as
 * renderFormatted(body, inner) (fast path, no block parse). Parsing is
 * memoised (parseBlocks, parseFormat). The container must allow block
 * children (a div, not a p).
 */
export function renderRich(body: string, inner: InnerRender): ReactNode[] {
  if (!hasBlocks(body)) return renderFormatted(body, inner);
  const blocks = parseBlocks(body);
  const first = blocks[0];
  if (blocks.length === 1 && first !== undefined && first.kind === 'para') {
    return renderFormatted(body, inner);
  }
  return blocks.map((block, i) => {
    const key = `blk-${i}`;
    switch (block.kind) {
      case 'para':
        // A trailing blank line is kept (pre-wrap drops a final line break).
        return (
          <span key={key} className="block">
            {renderFormatted(block.text, inner)}
            {block.text.endsWith('\n') ? '\n' : null}
          </span>
        );
      case 'ol':
        return (
          <ol key={key} start={block.start} className={FORMAT_OL_CLASS}>
            {block.items.map((item, j) => (
              <li key={`li-${j}`}>{renderFormatted(item, inner)}</li>
            ))}
          </ol>
        );
      case 'ul':
        return (
          <ul key={key} className={FORMAT_UL_CLASS}>
            {block.items.map((item, j) => (
              <li key={`li-${j}`}>{renderFormatted(item, inner)}</li>
            ))}
          </ul>
        );
      case 'quote':
        return (
          <blockquote key={key} className={FORMAT_QUOTE_CLASS}>
            {renderFormatted(block.text, inner)}
          </blockquote>
        );
    }
  });
}

/**
 * A message body with Slack blocks and WhatsApp formatting, then text runs and
 * links inside each styled segment (renderBodyLinks). Every saved-text surface
 * that shows a chat body renders through here.
 */
export function renderMessageBody(
  body: string,
  mine: boolean,
  origin: string | null = currentOrigin(),
  highlight: readonly string[] = [],
): ReactNode[] {
  return renderRich(body, (text) => renderBodyLinks(text, mine, origin, highlight));
}

/**
 * One link's tap target: an external url opens in a new tab, a link to this
 * app's own post or brief page is a router link, an unsafe url opens the check
 * sheet (never the site). `label` is what shows. Pure.
 */
function linkNode(
  url: string,
  label: ReactNode,
  key: string,
  mine: boolean,
  origin: string | null,
): ReactNode {
  const className = bodyLinkClass(mine);
  const target = classify(url, origin, APP_ENTITY_ROUTES);
  // An unsafe link opens the check sheet, never the site (its card warns too).
  const verdict = target.kind === 'external' ? checkLink(url) : null;
  if (verdict !== null && verdict.verdict === 'unsafe') {
    return (
      <UnsafeLinkText
        key={key}
        url={url}
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
      key={key}
      data-msg-link=""
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {label}
    </a>
  ) : (
    <Link key={key} data-msg-link="" to={target.path} className={className}>
      {label}
    </Link>
  );
}

/**
 * A [text](url) link: its text (inline styles drawn, mono literal, search
 * words marked) as the tap target, opening exactly like a pasted url. Pure.
 */
export function renderTextLink(
  text: string,
  url: string,
  key: string,
  mine: boolean,
  origin: string | null = currentOrigin(),
  highlight: readonly string[] = [],
): ReactNode {
  const label = renderFormatted(text, (t) =>
    highlight.length === 0 ? [t] : markSearchWords(t, highlight),
  );
  return linkNode(url, <>{label}</>, key, mine, origin);
}

/**
 * `inner` with [text](url) links taken out first: each link renders through
 * renderTextLink, the text between through `inner`. For surfaces whose inner
 * renderer does not know [text](url) (comments, brief fields). Pure.
 */
export function withTextLinks(
  inner: InnerRender,
  mine = false,
  origin: string | null = currentOrigin(),
  highlight: readonly string[] = [],
): InnerRender {
  return (text) => {
    const parts = splitLinks(text);
    const only = parts[0];
    if (parts.length === 1 && only !== undefined && only.kind === 'text') return inner(text);
    return parts.map((part, i) =>
      part.kind === 'text' ? (
        <Fragment key={`tl-${i}`}>{inner(part.text)}</Fragment>
      ) : (
        renderTextLink(part.text, part.url, `tl-${i}`, mine, origin, highlight)
      ),
    );
  };
}

/**
 * A message body as text runs and links. External urls open in a new tab and
 * show without the scheme; links to this app's own post or brief pages are
 * router links that open in-app; a [text](url) link shows its text. The whole
 * link text is the tap target. Pure: the origin is read at call time, so the
 * first paint is final.
 */
export function renderBodyLinks(
  body: string,
  mine: boolean,
  origin: string | null = currentOrigin(),
  highlight: readonly string[] = [],
): ReactNode[] {
  return tokenize(body).map((segment, i) => {
    if (segment.kind === 'text') {
      return highlight.length === 0 ? (
        segment.text
      ) : (
        <Fragment key={`part-${i}`}>{markSearchWords(segment.text, highlight)}</Fragment>
      );
    }
    if (segment.kind === 'link') {
      return renderTextLink(segment.text, segment.url, `part-${i}`, mine, origin, highlight);
    }
    return linkNode(segment.url, displayUrl(segment.url), `part-${i}`, mine, origin);
  });
}

/** A searched word in a bubble: the shared search highlight (SearchHighlight.tsx). */
export const markSearchWords = highlightNodes;
