// History-step keys for the chat's small sheets (FT40): Forward, Schedule,
// Priority, Who reacted and Reminder each push one entry while open (through
// useHistoryStep in src/lib/chat/use-history-step.ts), so system Back closes
// only the sheet and the chat under it stays. Message info already has its
// step (HISTORY_STEP_KEYS.readInfo, in MessageThread).

export const SHEET_STEP_KEYS = {
  forward: 'chatForward',
  schedule: 'chatSchedule',
  priority: 'chatPriority',
  whoReacted: 'chatWhoReacted',
  reminder: 'chatReminder',
} as const;
