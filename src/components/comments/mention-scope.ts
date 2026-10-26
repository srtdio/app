// Who the comment @-mention picker offers. Clients cannot see a draft post, so
// on a draft post's comments they are not offered at all (comment_create also
// rejects them with invalid_mention). Brief comments and every other stage
// offer the whole member list; chat mentions never come through here.

import { isClient } from '@/components/pages/pcs/roles';
import type { MentionCandidate } from '@/lib/workspace-members';
import type { CommentEntityType } from '@srtdio/comments';

export interface CommentMentionScope {
  entityType: CommentEntityType;
  /** The post's stage; absent on briefs or before the post has loaded. */
  postStage?: string | undefined;
}

/** Whether the comment's post is a draft (clients cannot see it). Pure. */
export function isDraftPostScope(scope: CommentMentionScope): boolean {
  return scope.entityType === 'post' && scope.postStage === 'draft';
}

/** The members the picker offers for a comment in `scope`. Pure; keeps order. */
export function commentMentionCandidates(
  members: readonly MentionCandidate[],
  scope: CommentMentionScope,
): MentionCandidate[] {
  if (!isDraftPostScope(scope)) return [...members];
  return members.filter((member) => !isClient(member.role));
}
