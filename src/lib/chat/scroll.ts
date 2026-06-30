/**
 * Pure scroll math for the chat thread, framework-free so it can be unit tested
 * without a DOM. "Near bottom" decides whether an incoming message should pull
 * the viewport down: if the reader is already parked at (or close to) the
 * latest message we follow new traffic, otherwise we leave their scroll alone.
 */

/** Slack-on the latest message within this many px still counts as "at bottom". */
export const NEAR_BOTTOM_THRESHOLD_PX = 120;

/**
 * True when the viewport bottom is within `threshold` px of the content bottom.
 * `scrollHeight - scrollTop - clientHeight` is the unseen distance below the
 * fold; 0 means pinned to the latest message.
 */
export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = NEAR_BOTTOM_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}
