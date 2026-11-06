// Copy shared by Bank meets Plan (the Plan screen rows, the item screen, the
// laptop month) and the idea cards in chat. Pure; no em-dashes.

/** Move to bank refused because the row is an approved post. */
export const MOVE_TO_BANK_LOCKED = "Couldn't move to bank. Approved posts are locked.";

/** The error line for a failed plan_item_to_bank. Pure. */
export function moveToBankError(message: string | null | undefined): string {
  if (message !== null && message !== undefined && message.includes('post_approved')) {
    return MOVE_TO_BANK_LOCKED;
  }
  return "Couldn't move to bank. Retry in a moment.";
}

/** The undo strip label after Move to bank. */
export const MOVED_TO_BANK_LABEL = 'Moved to bank';

/** The quiet line a concept leaves on the day it left the plan. Pure. */
export function movedToBankLine(title: string | null | undefined): string {
  const name = (title ?? '').trim();
  return `${name === '' ? 'Untitled idea' : name} moved to bank`;
}
