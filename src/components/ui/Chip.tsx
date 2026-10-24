import { cn } from '@/lib/cn';

interface ChipProps {
  label: string;
  selected?: boolean;
  variant?: 'default' | 'add';
  /**
   * Both sizes render the one 44px button height (design system); 'sm' stays
   * accepted so call sites compile.
   */
  size?: 'sm' | 'tap';
  /**
   * Optional extra classes appended last (e.g. a consumer's layout constraints
   * like shrink-0 / truncate). Purely additive: omitted by default so every
   * existing consumer renders byte-for-byte the same.
   */
  className?: string;
  onClick?: () => void;
}

const sizes: Record<NonNullable<ChipProps['size']>, string> = {
  sm: 'min-h-[44px] px-4',
  tap: 'min-h-[44px] px-4 justify-center',
};

export function Chip({
  label,
  selected = false,
  variant = 'default',
  size = 'sm',
  className,
  onClick,
}: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg border text-base font-normal transition-colors',
        sizes[size],
        'border-border text-fg-2 hover:bg-panel-2',
        selected && 'bg-accent-soft text-accent border-accent-line',
        variant === 'add' && 'border-dashed border-border text-fg-3',
        className,
      )}
    >
      {label}
    </button>
  );
}
