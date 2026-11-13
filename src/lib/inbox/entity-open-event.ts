// One read state (13 Nov 2026): a post, brief or plan item opening anywhere
// fires this, so the tab catch-up store reads every held entry of it (stage
// changes and brief created too, beyond inbox_mark_entity_read's comments and
// mentions). Its own module: no imports, nothing to mock.

/** Fired when a post, brief or plan item opens (detail: EntityReadOnOpen). */
export const ENTITY_READ_ON_OPEN_EVENT = 'sorted:entity-read-on-open';

/** Which item opened (the inbox entity type and id). */
export interface EntityReadOnOpen {
  type: 'post' | 'brief' | 'plan_item';
  id: string;
}
