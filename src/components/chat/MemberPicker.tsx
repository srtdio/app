import type { ReactElement } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { IconCheck } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import type { MemberOption } from '@/components/chat/member-picker';

interface MemberPickerProps {
  options: MemberOption[];
  selectedIds: readonly string[];
  onToggle: (userId: string) => void;
  loading: boolean;
  error: string | null;
  /** Shown when there are no selectable people (all excluded / none in workspace). */
  emptyLabel: string;
}

/**
 * A scrollable, selectable list of workspace members. Selection state is owned by
 * the parent (single-select for a DM peer, multi-select for a group), so this is
 * a controlled list that just reports toggles. Each row is a 44px touch target.
 */
export function MemberPicker(props: MemberPickerProps): ReactElement {
  if (props.loading) {
    return <p className="px-1 py-3 text-sm text-fg-3">Loading members</p>;
  }
  if (props.error !== null) {
    return (
      <div role="alert" className="rounded-md border border-bad px-3 py-2 text-sm text-bad">
        {props.error}
      </div>
    );
  }
  if (props.options.length === 0) {
    return <p className="px-1 py-3 text-sm text-fg-3">{props.emptyLabel}</p>;
  }
  const selected = new Set(props.selectedIds);
  return (
    <ul className="flex max-h-64 flex-col overflow-y-auto">
      {props.options.map((option) => {
        const isSelected = selected.has(option.userId);
        return (
          <li key={option.userId}>
            <button
              type="button"
              aria-pressed={isSelected}
              onClick={() => props.onToggle(option.userId)}
              className={cn(
                'flex w-full items-center gap-3 rounded-md px-2 min-h-[44px] text-left transition-colors',
                isSelected ? 'bg-accent-soft text-accent' : 'text-fg-2 hover:bg-panel-2',
              )}
            >
              <Avatar
                name={option.displayName}
                {...(option.avatarUrl !== null ? { src: option.avatarUrl } : {})}
                size="md"
              />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {option.displayName}
              </span>
              {isSelected ? <IconCheck size={18} /> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
