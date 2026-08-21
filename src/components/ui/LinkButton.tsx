import { cn } from '@/lib/cn';
import { IconArrowUpRight, IconLink } from '@/components/ui/icons';
import { parseExternalLink } from '@/lib/links';

interface LinkButtonProps {
  /** The raw URL. Anything that is not an http(s) URL renders nothing at all. */
  url: string;
  /** Optional layout-only classes appended last (e.g. w-full, align-middle). */
  className?: string;
}

/**
 * The one way this app renders an external URL: a bordered button labelled with
 * the DOMAIN only, never the raw href. No path or query string is ever painted
 * on screen (not as text, not as a title tooltip); the browser's own status bar
 * still shows the full destination on hover, so nothing is hidden.
 *
 * Renders null (never throws) when the url does not parse or is not http(s), so
 * a malformed jsonb value or a javascript: string simply disappears rather than
 * becoming a live anchor. Every colour comes through a token defined in both
 * :root and .dark, so light/dark parity is automatic.
 */
export function LinkButton({ url, className }: LinkButtonProps) {
  const link = parseExternalLink(url);
  if (link === null) return null;

  return (
    <a
      href={link.href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open ${link.domain} in a new tab`}
      className={cn(
        'group inline-flex items-center gap-2 min-h-[44px] max-w-full px-3 rounded-md border border-border bg-panel-2 text-sm text-fg no-underline transition-colors hover:bg-panel-3 hover:border-accent-line focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        className,
      )}
    >
      <span className="shrink-0 text-accent">
        <IconLink size={16} />
      </span>
      <span className="min-w-0 truncate">{link.domain}</span>
      <span className="shrink-0 text-fg-3 transition-colors group-hover:text-accent">
        <IconArrowUpRight size={16} />
      </span>
    </a>
  );
}
