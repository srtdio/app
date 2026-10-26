// A task's tick box (16px glyph inside a 44px target in rows). To do: an
// empty rounded square; Done: a filled accent square with a panel-coloured
// tick. Tokens only, so light and dark stay at parity; the label is
// screen-reader text. The drawing lives in ui/icons.tsx (TaskBoxGlyph).

import type { ReactElement } from 'react';
import type { TaskStatus } from '@/lib/chat/tasks';
import { ICON_SIZE, TaskBoxGlyph } from '@/components/ui/icons';

export const STATUS_LABEL: Record<TaskStatus, string> = { todo: 'To do', done: 'Done' };

export function TaskGlyph(props: { status: TaskStatus; size?: 16 | 18 }): ReactElement {
  const size = props.size ?? ICON_SIZE.nav;
  return (
    <span className="inline-flex shrink-0" data-task-glyph={props.status}>
      <TaskBoxGlyph done={props.status === 'done'} size={size} />
    </span>
  );
}
