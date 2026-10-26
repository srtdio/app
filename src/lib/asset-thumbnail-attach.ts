// Browser-only: attaches a thumbnail that was still being made when the
// original upload was stored. Kept out of asset-upload.ts because that module
// is reached by Workers (through chat/attachments) and this one logs with the
// browser logger (Sentry + the Vite env). Browser callers pass
// attachLateThumbnail as UploadConfig.attachThumbnail.

import {
  dispatchUploadComplete,
  errorCode,
  postThumbnail,
  thumbnailField,
  type StoredThumbnail,
  type ThumbnailAttacher,
  type UploadConfig,
} from '@/lib/asset-upload';
import type { Thumbnail } from '@/lib/files/thumbnail';
import { logger } from '@/lib/logger';

/**
 * Once the thumbnail is made, POST it to /thumbnail, then announce the upload
 * again and tell config.onThumbnail. Runs after the outcome resolved; never
 * throws and never changes the outcome: a missing thumbnail or a failed post
 * is null (the failure is logged).
 */
export const attachLateThumbnail: ThumbnailAttacher = async (config, versionId, thumbnail) => {
  try {
    const made = await thumbnail;
    if (made === null || !made.ok) return null;
    const stored = await storeThumbnail(config, versionId, made);
    if (stored === null) return null;
    dispatchUploadComplete(config.workspaceId);
    config.onThumbnail?.(stored);
    return stored;
  } catch (error) {
    logger.warn('asset thumbnail attach failed', {
      asset_version_id: versionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

/** POST the made thumbnail; the stored rendition, or null (logged) when refused or failed. */
async function storeThumbnail(
  config: UploadConfig,
  versionId: string,
  made: Thumbnail,
): Promise<StoredThumbnail | null> {
  try {
    const reply = await postThumbnail(config, versionId, made);
    if (!reply.ok) {
      logger.warn('asset thumbnail attach refused', {
        asset_version_id: versionId,
        status: reply.status,
        code: errorCode(reply.body),
      });
      return null;
    }
    return thumbnailField(reply.body);
  } catch (error) {
    logger.warn('asset thumbnail attach failed', {
      asset_version_id: versionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
