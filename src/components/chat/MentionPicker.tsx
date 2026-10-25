// The @ member picker above the composer. It mirrors the hash post picker's
// inline panel exactly: the same anchor (absolute, full composer width, above
// the input), the same bordered panel capped at 45vh, no motion, and the same
// dismissal (Escape, or the caret leaving the @ run). Rows are 44px min: avatar,
// display name, then @username and role. A press never takes focus from the textarea (so the
// keyboard stays up on touch); the keyboard is driven by the composer, which
// owns the active row. In a group the first row can be "@all" ("Everyone in
// this group"), drawn with the same row grammar. Tokens only, so light and
// dark stay at parity.

import type { ReactElement } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { cn } from '@/lib/cn';
import { roleLabel } from '@/components/pages/settings/members-data';
import { ALL_MENTION, ALL_MENTION_LINE, type MentionMember } from '@/lib/chat/mentions';

/** The accessible name of the picker's list. */
export const MENTION_PICKER_LABEL = 'Mention someone';

/** Step the active row with Up / Down, wrapping at both ends. Pure. */
export function stepActive(active: number, count: number, key: 'ArrowUp' | 'ArrowDown'): number {
  if (count === 0) return 0;
  const next = key === 'ArrowDown' ? active + 1 : active - 1;
  return (next + count) % count;
}

export interface MentionPickerProps {
  members: readonly MentionMember[];
  /** The row Enter / Tab would pick. */
  active: number;
  onPick: (member: MentionMember) => void;
}

/** The panel; renders nothing when no member matches. */
export function MentionPicker(props: MentionPickerProps): ReactElement | null {
  if (props.members.length === 0) return null;
  return (
    <div
      data-mention-picker=""
      className="flex max-h-[45vh] flex-col overflow-y-auto rounded-lg border border-border bg-panel"
    >
      <ul role="listbox" aria-label={MENTION_PICKER_LABEL} className="flex flex-col">
        {props.members.map((member, index) => (
          <li
            key={member.userId}
            role="option"
            aria-selected={index === props.active}
            data-mention-option={member.userId}
            // Keep focus (and the touch keyboard) in the textarea.
            onPointerDown={(event) => event.preventDefault()}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => props.onPick(member)}
            className={cn(
              'flex min-h-[44px] cursor-pointer items-center gap-3 border-b border-border px-3 py-2 last:border-b-0 hover:bg-panel-2',
              index === props.active ? 'bg-panel-2' : undefined,
            )}
          >
            {member.userId === ALL_MENTION ? (
              <>
                <span
                  aria-hidden="true"
                  className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent-hover"
                >
                  @
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-base font-semibold text-fg">@{ALL_MENTION}</span>
                  <span className="truncate text-sm text-fg-3">{ALL_MENTION_LINE}</span>
                </span>
              </>
            ) : (
              <>
                <Avatar
                  name={member.displayName}
                  {...(member.avatarUrl !== null ? { src: member.avatarUrl } : {})}
                  role="row"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-base font-medium text-fg">
                    {member.displayName}
                  </span>
                  {member.username || member.role !== null ? (
                    <span className="truncate text-sm text-fg-3">
                      {member.username ? (
                        <span className="font-mono text-fg-2">@{member.username}</span>
                      ) : null}
                      {member.username && member.role !== null ? ' · ' : null}
                      {member.role !== null ? roleLabel(member.role) : null}
                    </span>
                  ) : null}
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
