// @srtdio/briefs: the brief create / close / read layer. Writes go through the
// SECURITY DEFINER procs (via @srtdio/rpc); reads are plain RLS-scoped SELECTs.
// Briefs are read-only after creation: this package exposes create, close, and
// read, and deliberately NO update path.

export type { Client, DomainError, DomainErrorCode, Result } from '@srtdio/rpc';

export { createBrief, type CreateBriefInput, type CreateBriefResult } from './create';
export { closeBrief, type CloseBriefInput } from './close';
export {
  BRIEFS_PAGE_SIZE,
  getBrief,
  listBriefs,
  type Brief,
  type BriefWithLinkedCount,
  type BriefWithThumbnail,
  type ListBriefsFilters,
} from './read';
export { getBriefGallery, type BriefGalleryItem } from './reads';
