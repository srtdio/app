import { cn } from '@/lib/cn';

export interface TabItem {
  key: string;
  label: string;
}

interface TabsProps {
  items: TabItem[];
  active: string;
  onChange: (key: string) => void;
}

export function Tabs({ items, active, onChange }: TabsProps) {
  return (
    <div className="flex items-stretch gap-1 border-b border-border overflow-x-auto">
      {items.map((tab) => {
        const isActive = tab.key === active;
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => onChange(tab.key)}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'relative inline-flex items-center min-h-[44px] px-3 text-sm whitespace-nowrap transition-colors',
              isActive ? 'text-fg' : 'text-fg-2 hover:text-fg',
            )}
          >
            {tab.label}
            {isActive ? (
              <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
