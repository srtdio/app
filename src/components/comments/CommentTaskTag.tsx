// The one grey tag under a comment with a task (ui/Tag; "Task done ..." in the
// good token), handed to chat's bubble through its bottomLine slot. Agency: a
// tap opens that chat's Tasks sheet scrolled to the task (chatTaskHref,
// handled by the chat). An Approver's tag is static. Outside a router
// (isolated mounts) it is static too.

import type { ReactElement } from 'react';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import { PressableRow } from '@/components/ui/PressableRow';
import { Tag } from '@/components/ui/Tag';
import type { TaskTag } from '@/lib/comment-tasks';

export function CommentTaskTag(props: { tag: TaskTag }): ReactElement {
  const routed = useInRouterContext();
  const tag = <Tag label={props.tag.text} tone={props.tag.tone} />;
  if (props.tag.href === null || !routed) {
    return (
      <span data-comment-task-tag="" className="mt-2 flex">
        {tag}
      </span>
    );
  }
  return <TaskTagLink tag={props.tag} href={props.tag.href} />;
}

function TaskTagLink(props: { tag: TaskTag; href: string }): ReactElement {
  const navigate = useNavigate();
  return (
    <span data-comment-task-tag="" className="flex">
      <PressableRow
        inline
        type="button"
        data-comment-task-open=""
        aria-label={`${props.tag.text}. Open in Tasks`}
        onClick={() => navigate(props.href)}
        className="flex min-h-11 items-center"
      >
        <Tag label={props.tag.text} tone={props.tag.tone} />
      </PressableRow>
    </span>
  );
}
