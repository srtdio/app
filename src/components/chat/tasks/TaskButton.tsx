// The composer's Tasks button: 44px round, the task-square icon, and an
// 8px accent dot (ringed in panel) while someone else changed the list since
// this device last opened it; the dot pops in (docs/motion.md, pop). While
// another member holds unsaved changes in their sheet the button carries
// data-task-editing (never a pulse: motion never fades). Pressable: no iOS
// selection callout.

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { pop, useMoveOnMount } from '@/lib/motion';
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
  // A dot already there when the button first paints stays still; one that
  // appears later pops in.
  const [painted, setPainted] = useState(false);
  useEffect(() => setPainted(true), []);
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
      className={cn('relative shrink-0', NO_TOUCH_SELECT)}
    >
      <span className="inline-flex">
        <IconTaskSquare size={ICON_SIZE.control} />
      </span>
      {props.unseen ? <UnseenDot popIn={painted} /> : null}
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

/**
 * The accent dot: it pops in from .9 (ease-pop) when it appears while the
 * composer is on screen; a dot already there when the chat paints stays still.
 */
function UnseenDot(props: { popIn: boolean }): ReactElement {
  const ref = useRef<HTMLSpanElement>(null);
  useMoveOnMount(ref, (el) => pop(el), props.popIn);
  return (
    <span
      ref={ref}
      aria-hidden="true"
      data-task-dot=""
      className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-accent ring-2 ring-panel"
    />
  );
}
