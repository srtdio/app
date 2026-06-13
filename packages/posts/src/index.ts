// @srtdio/posts: the post domain package. Writes go through the SECURITY
// DEFINER procs (via @srtdio/rpc): post_create (which also makes version 1),
// post_version_create (edits, v2+), post_update (metadata), post_caption_update
// and gallery_set (both auto-version), annotation_create, and stage_transition.
// Reads are plain RLS-scoped SELECTs. The stage machine mirrors the locked DB
// transition map for client-side gating; enforcement is always server-side.
//
// The actor is always auth.uid() server-side; no caller-supplied actor id is
// ever sent. trace_id is an explicit RPC parameter, minted as a uuid_v7 at
// entry when a caller does not supply one.

export type { Client, DomainError, DomainErrorCode, Result } from '@srtdio/rpc';

export {
  STAGE_TRANSITIONS,
  canTransition,
  stageTransition,
  type Stage,
  type StageTransitionInput,
} from './stage-machine';

export {
  postCreate,
  PostCreatePayloadSchema,
  POST_PLATFORMS,
  POST_FORMATS,
  POST_ORIGINS,
  type PostCreateInput,
  type PostCreatePayload,
} from './create';

export { postVersionCreate, type PostVersionCreateInput } from './version';

export { postUpdate, PostUpdateSchema, type PostUpdateInput } from './update';

export { postCaptionUpdate, PostCaptionUpdateSchema, type PostCaptionUpdateInput } from './caption';

export { gallerySet, GallerySetSchema, type GallerySetInput } from './gallery';

export { annotationCreate, AnnotationCreateSchema, type AnnotationCreateInput } from './annotate';

export {
  getPost,
  listPosts,
  listPostsForPicker,
  readPostsByIds,
  POSTS_PAGE_SIZE,
  POSTS_PAGE_SIZE_MAX,
  type ListPostsForPickerInput,
  type ListPostsInput,
  type Post,
  type PostAnnotation,
  type PostCardFields,
  type PostDetail,
  type PostVersion,
} from './reads';
