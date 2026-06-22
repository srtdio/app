// A small lowercase letter badge standing in for a post's platform on the card
// meta line. Token-only styling so light/dark parity is automatic; an unknown
// platform value degrades to its first two letters rather than an empty badge.

const PLATFORM_MARK: Record<string, string> = {
  linkedin: 'in',
  x: 'x',
  instagram: 'ig',
  facebook: 'fb',
  threads: 'th',
};

export function PlatformMark({ platform }: { platform: string }) {
  const mark = PLATFORM_MARK[platform] ?? platform.slice(0, 2).toLowerCase();
  return (
    <span
      aria-label={platform}
      className="inline-flex h-[19px] min-w-[19px] items-center justify-center rounded-md border border-border bg-panel-2 px-1 text-[10px] font-bold lowercase leading-none text-fg-2"
    >
      {mark}
    </span>
  );
}
