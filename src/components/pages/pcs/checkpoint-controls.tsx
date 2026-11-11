// The resolved circle colours catch up's old feedback rows still draw
// (comments/CheckpointCircle). Tokens only.

/** The filled "resolved" circle: tokens only, never a literal colour. The fill is
 *  bg-good-solid (the light green kept in both themes so on-colour ink stays at
 *  4.5:1 or more) under the accent-fg ink token. Shared with the strip chips. */
export const RESOLVED_FILL_CLASS = 'border-good bg-good-solid text-accent-fg';

/** The hollow "resolved, not yet confirmed" circle: the good outline and ink over
 *  a transparent body, so it reads as done-by-the-creator but still awaiting the
 *  approver's Confirm. Tokens only; shared with the strip chips. */
export const RESOLVED_HOLLOW_CLASS = 'border-good bg-transparent text-good';
