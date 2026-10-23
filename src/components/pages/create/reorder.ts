// Tile reorder math for the create sheet's file row. The dragged tile moves on
// the X axis only (translate, no rotation); the others shift by one slot with
// transform. Pure so it unit-tests without a DOM.

/** Move the element at `from` to `to`, keeping the rest in order. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const out = [...items];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [moved] = out.splice(from, 1);
  if (moved !== undefined) out.splice(to, 0, moved);
  return out;
}

/**
 * Reorder only the elements `isPart` picks (the media), keeping every other
 * element in its own slot. from/to index the picked elements.
 */
export function moveWithin<T>(
  items: readonly T[],
  isPart: (item: T) => boolean,
  from: number,
  to: number,
): T[] {
  const slots: number[] = [];
  items.forEach((item, index) => {
    if (isPart(item)) slots.push(index);
  });
  const parts = moveItem(
    slots.map((index) => items[index] as T),
    from,
    to,
  );
  const out = [...items];
  slots.forEach((slot, i) => {
    out[slot] = parts[i] as T;
  });
  return out;
}

/** Where a tile dragged dx pixels from `from` lands, one slot per `slot` pixels. */
export function dropIndex(from: number, dx: number, slot: number, count: number): number {
  if (slot <= 0 || count <= 0) return from;
  const to = from + Math.round(dx / slot);
  return Math.min(Math.max(to, 0), count - 1);
}

/** Clamp a drag so the tile never leaves the row. */
export function clampDrag(from: number, dx: number, slot: number, count: number): number {
  const min = -from * slot;
  const max = (count - 1 - from) * slot;
  return Math.min(Math.max(dx, min), max);
}

/** How far a resting tile shifts while another is dragged from `from` to `to`. */
export function shiftFor(index: number, from: number, to: number, slot: number): number {
  if (index === from) return 0;
  if (from < to && index > from && index <= to) return -slot;
  if (from > to && index >= to && index < from) return slot;
  return 0;
}
