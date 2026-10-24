// A task's tick box (16px glyph inside a 44px target in rows). To do: an
// empty rounded square; Done: a filled accent square with a panel-coloured
// tick. Tokens only, so light and dark stay at parity; the label is
// screen-reader text. Icon stroke 1.7.

import type { ReactElement } from 'react';
import { cn } from '@/lib/cn';
import type { TaskStatus } from '@/lib/chat/tasks';
import { ICON_SIZE } from '@/components/ui/icons';

const STROKE = 1.7;

export const STATUS_LABEL: Record<TaskStatus, string> = { todo: 'To do', done: 'Done' };

export function TaskGlyph(props: { status: TaskStatus; size?: 16 | 18 }): ReactElement {
  const size = props.size ?? ICON_SIZE.nav;
  const done = props.status === 'done';
  return (
    <span className="inline-flex shrink-0" data-task-glyph={props.status}>
      <svg
        aria-hidden="true"
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cn(done ? 'text-accent' : 'text-fg-3')}
      >
        {done ? (
          <>
            <rect x={1} y={1} width={14} height={14} rx={4} fill="currentColor" />
            <path d="M4.6 8.2l2.3 2.3 4.5-4.8" className="stroke-panel" />
          </>
        ) : (
          <rect x={1.5} y={1.5} width={13} height={13} rx={3.6} stroke="currentColor" />
        )}
      </svg>
    </span>
  );
}
