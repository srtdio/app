// A message body as text runs and links: chat bubbles (MessageThread) and the
// Plan item screen's concept description render through this one function, so
// a link looks and opens the same everywhere. Moved out of MessageThread.tsx
// unchanged, so screens that show a body never import the thread.

import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
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

/**
 * A message body as text runs and links. External urls open in a new tab and
 * show without the scheme; links to this app's own post or brief pages are
 * router links that open in-app. The whole link text is the tap target. Pure:
 * the origin is read at call time, so the first paint is final.
 */
export function renderMessageBody(
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
