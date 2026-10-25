import type { ReactElement } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { PressableRow } from '@/components/ui/PressableRow';
import { SelectCheck } from '@/components/ui/SelectCheck';
import { cn } from '@/lib/cn';
import type { MemberOption } from '@/components/chat/member-picker';
import { listSkeleton } from '@/components/chat/ListSkeleton';

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
    return listSkeleton('Loading members');
  }
  if (props.error !== null) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-bad bg-bad-soft px-4 py-3 text-base text-bad"
      >
        {props.error}
      </div>
    );
  }
  if (props.options.length === 0) {
    return <p className="px-1 py-3 text-base text-fg-3">{props.emptyLabel}</p>;
  }
  const selected = new Set(props.selectedIds);
  return (
    <ul className="flex max-h-64 flex-col overflow-y-auto">
      {props.options.map((option) => {
        const isSelected = selected.has(option.userId);
        return (
          <li key={option.userId}>
            <PressableRow
              type="button"
              aria-pressed={isSelected}
              onClick={() => props.onToggle(option.userId)}
              className={cn(
                'flex items-center gap-3 px-2 transition-colors',
                isSelected ? 'bg-accent-soft text-accent' : 'text-fg-2',
              )}
            >
              <Avatar
                name={option.displayName}
                {...(option.avatarUrl !== null ? { src: option.avatarUrl } : {})}
                role="row"
              />
              <span className="min-w-0 flex-1 truncate text-base font-medium">
                {option.displayName}
              </span>
              <SelectCheck checked={isSelected} />
            </PressableRow>
          </li>
        );
      })}
    </ul>
  );
}
