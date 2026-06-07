import { cn } from '@/lib/cn';

interface ChipProps {
  label: string;
  selected?: boolean;
  variant?: 'default' | 'add';
  onClick?: () => void;
}

export function Chip({ label, selected = false, variant = 'default', onClick }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 h-8 px-3 rounded-full border text-sm transition-colors',
        'border-border text-fg-2 hover:bg-panel-2',
        selected && 'bg-accent-soft text-accent border-accent-line',
        variant === 'add' && 'border-dashed border-border text-fg-3',
      )}
    >
      {label}
    </button>
  );
}
