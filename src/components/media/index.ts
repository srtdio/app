// The shared thumbnail module: one tile + one presign hook + one fallback type,
// consumed by Assets, Pipeline (and later Briefs). There is no second copy.
export { Thumbnail } from './Thumbnail';
export type { ThumbnailProps, ThumbnailFallback } from './Thumbnail';
export { useThumbnail } from './use-thumbnail';
export type { UseThumbnailArgs, ThumbnailHandle } from './use-thumbnail';
