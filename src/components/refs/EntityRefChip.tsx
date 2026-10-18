import { useOptionalToast } from '@/components/ui/toast';
import { COPY_FAILED, copyText } from '@/lib/clipboard';
import { formatEntityRef, entityUrlPath } from '@/lib/entityRef';

interface EntityRefChipProps {
  kind: 'post' | 'brief';
  /** Uppercase workspace key, e.g. "GBL". */
  entityKey: string;
  /** Per-workspace entity number, e.g. 142. */
  number: number;
  /** Fired after the pretty link is copied to the clipboard (toast feedback). */
  onCopied: () => void;
}

/**
 * The reference chip shown in a post/brief detail header, e.g. GBL-142. Tapping
 * it copies the absolute pretty link (window.location.origin + entityUrlPath) to
 * the clipboard, then fires `onCopied` for the caller's toast. The domain is
 * never hardcoded: it comes from window.location.origin. The 44x44px touch
 * target is met via the h-11 min-height and generous padding; token-only classes
 * keep light and dark parity.
 */
export function EntityRefChip({ kind, entityKey, number, onCopied }: EntityRefChipProps) {
  const label = formatEntityRef(entityKey, number);
  const toast = useOptionalToast();

  const handleCopy = (): void => {
    const link = window.location.origin + entityUrlPath(kind, entityKey, number);
    void copyText(link).then((ok) => {
      if (ok) onCopied();
      else toast?.show({ title: COPY_FAILED });
    });
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={`Copy link to ${label}`}
      title="Copy link"
      className="inline-flex h-11 min-w-[44px] items-center gap-1.5 rounded-full border border-border bg-panel px-3 text-xs font-semibold tabular-nums text-fg-2 transition-colors hover:bg-panel-2 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {label}
    </button>
  );
}
