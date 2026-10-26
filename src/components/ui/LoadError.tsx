// The shared load failure for a page or panel: "Couldn't load {thing}." plus
// a 44px Retry. Tokens only, so light and dark parity comes from the theme.
// role=alert so a screen reader hears it when it appears. Pages adopt it in
// their own PRs; the copy for a failed action lives in src/lib/error-copy.ts.

import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

interface LoadErrorProps {
  /** What failed to load, in the sentence: "posts", "this brief", "the chat list". */
  title: string;
  onRetry: () => void;
  /** A retry is in flight: the button is disabled and reads "Retrying…". */
  retrying?: boolean;
  className?: string;
}

/** The sentence LoadError shows. Pure. */
export function loadErrorText(title: string): string {
  return `Couldn't load ${title}.`;
}

export function LoadError({
  title,
  onRetry,
  retrying = false,
  className,
}: LoadErrorProps): ReactElement {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center gap-3 rounded-xl border border-border bg-panel px-4 py-6 text-center',
        className,
      )}
    >
      <p className="text-base text-fg-2">{loadErrorText(title)}</p>
      <Button onClick={onRetry} disabled={retrying} aria-busy={retrying}>
        {retrying ? 'Retrying…' : 'Retry'}
      </Button>
    </div>
  );
}
