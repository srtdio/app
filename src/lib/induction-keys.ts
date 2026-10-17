// The data-induction attribute values on the real controls the guide boxes.
// One place, never literals: every anchor reads its value from here.

export const INDUCTION_KEYS = {
  topbarWorkspaceSlot: 'topbar-workspace-slot',
  workspaceCreateSubmit: 'workspace-create-submit',
  pipelineStageRow: 'pipeline-stage-row',
  pipelineApprovedChip: 'pipeline-approved-chip',
  pipelineCreate: 'pipeline-create',
  pipelinePostRow: 'pipeline-post-row',
  pipelineDraftChip: 'pipeline-draft-chip',
  postSheetCaption: 'post-sheet-caption',
  postSheetFormat: 'post-sheet-format',
  postSheetFormatSingle: 'post-sheet-format-single',
  postSheetMedia: 'post-sheet-media',
  postSheetPrimary: 'post-sheet-primary',
  membersInvite: 'members-invite',
  postCaptionText: 'post-caption-text',
  postCommentButton: 'post-comment-button',
  postCommentComposer: 'post-comment-composer',
  postCommentPost: 'post-comment-post',
  postApprove: 'post-approve',
  postApproveConfirm: 'post-approve-confirm',
  briefsNew: 'briefs-new',
  briefsFirstCard: 'briefs-first-card',
  briefOpenPlan: 'brief-open-plan',
  briefSheetTitle: 'brief-sheet-title',
  briefSheetObjective: 'brief-sheet-objective',
  briefSheetCreate: 'brief-sheet-create',
  assetsAdd: 'assets-add',
  activityList: 'activity-list',
  activityTab: 'activity-tab',
  chatTab: 'chat-tab',
  chatDefaultGroupRow: 'chat-default-group-row',
  chatTranscript: 'chat-transcript',
  chatHash: 'chat-hash',
  chatPlus: 'chat-plus',
  chatAttachTray: 'chat-attach-tray',
  chatTasks: 'chat-tasks',
  chatMic: 'chat-mic',
  chatPostCard: 'chat-post-card',
} as const;

export type InductionKey = (typeof INDUCTION_KEYS)[keyof typeof INDUCTION_KEYS];

/** The CSS selector for one control. Searched document-wide, so portals count. */
export function inductionSelector(key: InductionKey): string {
  return `[data-induction="${key}"]`;
}
