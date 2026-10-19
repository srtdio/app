// Shared fixtures for the X5 pipeline regression tests.
import type { PipelinePost, Stage } from '@srtdio/posts';

export function x5Post(overrides: Partial<PipelinePost> = {}): PipelinePost {
  return {
    id: 'p1',
    workspace_id: 'w1',
    number: 1,
    title: 'Post title',
    stage: 'review' as Stage,
    platform: 'instagram',
    format: 'single_image',
    origin: 'manual',
    legacy_author_name: null,
    caption: null,
    brief_id: null,
    bucket_id: null,
    owner_user_id: 'u1',
    created_by: 'u1',
    target_date: null,
    deleted_at: null,
    row_version: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    stage_entered_at: '2026-01-01T00:00:00Z',
    approved_by: null,
    approved_on_behalf_of: null,
    approved_at: null,
    thumbnailAssetVersionId: null,
    ...overrides,
  };
}
