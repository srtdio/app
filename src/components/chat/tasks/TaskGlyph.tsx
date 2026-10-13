// A task's status glyph (16 in rows, 14 in the status grid). To do: a ring;
// Waiting: a dashed ring; Shared: a ring with its right half filled; Approved
// and Rejected: a filled disc with a panel-coloured tick or x. Tokens only, so
// light and dark stay at parity; the label is screen-reader text.

import type { ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { STATUS_LABEL, type TaskStatus } from '@/lib/chat/tasks';

const STROKE = 1.7;

export function TaskGlyph(props: {
  status: TaskStatus;
  size?: 14 | 16;
  /** Visible label nearby (the status grid): no duplicate screen-reader text. */
  labelled?: boolean;
}): ReactElement {
  const size = props.size ?? 16;
  const { status } = props;
  return (
    <span className="inline-flex shrink-0" data-task-glyph={status}>
      <svg
        aria-hidden="true"
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cn(
          status === 'todo' && 'text-fg-2',
          status === 'waiting' && 'text-stage-review',
          status === 'shared' && 'text-accent',
          status === 'approved' && 'text-stage-approved',
          status === 'rejected' && 'text-stage-rejected',
        )}
      >
        {status === 'todo' ? <circle cx={8} cy={8} r={6.2} stroke="currentColor" /> : null}
        {status === 'waiting' ? (
          <circle cx={8} cy={8} r={6.2} stroke="currentColor" strokeDasharray="2.4 2.2" />
        ) : null}
        {status === 'shared' ? (
          <>
            <circle cx={8} cy={8} r={6.2} stroke="currentColor" />
            <path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor" />
          </>
        ) : null}
        {status === 'approved' ? (
          <>
            <circle cx={8} cy={8} r={7} fill="currentColor" />
            <path d="M5 8.2l2 2 4-4.4" className="stroke-panel" />
          </>
        ) : null}
        {status === 'rejected' ? (
          <>
            <circle cx={8} cy={8} r={7} fill="currentColor" />
            <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" className="stroke-panel" />
          </>
        ) : null}
      </svg>
      {props.labelled === true ? null : <span className="sr-only">{STATUS_LABEL[status]}</span>}
    </span>
  );
}
