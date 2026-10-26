// When an open's plan cards read their bundles: never before the chat bundle
// returns (the cards wait at their final size), started the moment it does
// (its shared plan ids plus every plan shared on its page), OR when the user
// taps a plan card first, whichever comes first. Asks made before then are
// held and go with that first fire; after it, only ids never fired go. An id
// is never fired twice in one open (a retry or a refresh is the cache's own
// call, not a fire). Each fire carries at most PLAN_FIRE_LIMIT ids; more go
// in the next one at once. Pure state over an injected `fire`; one per open.

/** The most plan ids one fire carries. */
export const PLAN_FIRE_LIMIT = 200;

export type PlanFireTrigger = 'bundle' | 'tap';

export interface PlanFireOnce {
  /** A card or the ticker asks for these ids: held until the open fires, then new ones go. */
  request: (ids: readonly string[]) => void;
  /** The chat bundle returned (or failed): fire its ids and everything held. */
  bundleReturned: (ids: readonly string[]) => void;
  /** A plan card was tapped before the bundle returned: fire it and everything held. */
  tapped: (ids: readonly string[]) => void;
  /** What opened the gate, or null while the open still waits. */
  openedBy: () => PlanFireTrigger | null;
  /** Every id fired so far, in order (tests). */
  fired: () => readonly string[];
}

export function createPlanFireOnce(
  fire: (ids: string[]) => void,
  limit: number = PLAN_FIRE_LIMIT,
): PlanFireOnce {
  const fired = new Set<string>();
  const order: string[] = [];
  const held = new Set<string>();
  let opened: PlanFireTrigger | null = null;

  const send = (ids: Iterable<string>): void => {
    const fresh: string[] = [];
    for (const id of ids) {
      if (id === '' || fired.has(id)) continue;
      fired.add(id);
      order.push(id);
      fresh.push(id);
    }
    for (let at = 0; at < fresh.length; at += limit) fire(fresh.slice(at, at + limit));
  };

  const open = (trigger: PlanFireTrigger, ids: readonly string[]): void => {
    if (opened !== null) {
      send(ids);
      return;
    }
    opened = trigger;
    const all = [...ids, ...held];
    held.clear();
    send(all);
  };

  return {
    request(ids) {
      if (opened !== null) {
        send(ids);
        return;
      }
      for (const id of ids) if (id !== '') held.add(id);
    },
    bundleReturned: (ids) => open('bundle', ids),
    tapped: (ids) => open('tap', ids),
    openedBy: () => opened,
    fired: () => order,
  };
}
