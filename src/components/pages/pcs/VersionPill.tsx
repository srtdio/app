// The vN pill on the PCS header: shows the current version number and opens the
// version-history sheet. Hidden by the page when a post has no versions. A full
// 44x44 tap target, styled with theme tokens for light/dark parity.

interface VersionPillProps {
  /** The current (highest) version number. */
  versionNumber: number;
  onClick: () => void;
}

export function VersionPill({ versionNumber, onClick }: VersionPillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Version history, current version ${versionNumber}`}
      aria-haspopup="dialog"
      className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-full border border-border px-3 text-xs font-medium tabular-nums text-fg-2 transition-colors hover:bg-panel-2 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      v{versionNumber}
    </button>
  );
}
