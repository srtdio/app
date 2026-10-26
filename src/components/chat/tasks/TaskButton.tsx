// The composer's Tasks button: 44px round, the task-square icon, and an
// 8px accent dot (ringed in panel) while someone else changed the list since
// this device last opened it. While another member holds unsaved changes in
// their sheet the icon pulses gently (opacity only; still under reduced
// motion). Pressable: no iOS selection callout.

import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { ICON_SIZE, IconTaskSquare } from '@/components/ui/icons';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { cn } from '@/lib/cn';
import { INDUCTION_KEYS } from '@/lib/induction';

const TASK_BUTTON_LABEL = 'Tasks';

export function TaskButton(props: {
  unseen: boolean;
  /** Someone else is editing the list right now. */
  editing?: boolean;
  onOpen: () => void;
}): ReactElement {
  return (
    <Button
      type="button"
      variant="secondary"
      shape="round"
      aria-label={TASK_BUTTON_LABEL}
      data-task-button=""
      data-induction={INDUCTION_KEYS.chatTasks}
      {...(props.unseen ? { 'data-task-unseen': '' } : {})}
      {...(props.editing === true ? { 'data-task-editing': '' } : {})}
      onClick={props.onOpen}
      onContextMenu={(event) => event.preventDefault()}
      className={cn(
        'relative shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        NO_TOUCH_SELECT,
      )}
    >
      <span
        className={cn(
          'inline-flex',
          props.editing === true && 'animate-pulse motion-reduce:animate-none',
        )}
      >
        <IconTaskSquare size={ICON_SIZE.control} />
      </span>
      {props.unseen ? (
        <span
          aria-hidden="true"
          data-task-dot=""
          className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-accent ring-2 ring-panel"
        />
      ) : null}
    </Button>
  );
}

/** When this device last opened a chat's list (epoch ms); null when never or unreadable. */
export function readTasksSeen(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const ms = Number(raw);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/** Remember that this device opened a chat's list now. */
export function writeTasksSeen(key: string, ms: number): void {
  try {
    window.localStorage.setItem(key, String(ms));
  } catch {
    // Storage unavailable (private mode): the dot simply stays.
  }
}
