import { cn } from '@/lib/cn';

interface ChipProps {
  label: string;
  selected?: boolean;
  variant?: 'default' | 'add';
  /**
   * 'sm' (default) is the 32px display/tag size; 'tap' is the 44px touch-target
   * size for chips that act as tappable inputs (filters, selectable options).
   */
  size?: 'sm' | 'tap';
  onClick?: () => void;
}

const sizes: Record<NonNullable<ChipProps['size']>, string> = {
  sm: 'h-8 px-3',
  tap: 'min-h-[44px] px-4 justify-center',
};

export function Chip({
  label,
  selected = false,
  variant = 'default',
  size = 'sm',
  onClick,
}: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border text-sm transition-colors',
        sizes[size],
        'border-border text-fg-2 hover:bg-panel-2',
        selected && 'bg-accent-soft text-accent border-accent-line',
        variant === 'add' && 'border-dashed border-border text-fg-3',
      )}
    >
      {label}
    </button>
  );
}
