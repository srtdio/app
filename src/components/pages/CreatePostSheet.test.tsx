import { describe, expect, it, vi } from 'vitest';
import {
  buildPostCreatePayload,
  initialCreateState,
  submitCreatePost,
  type BuildPayloadInput,
} from '@/components/pages/CreatePostSheet';
import type { Client, Result } from '@srtdio/rpc';
import type { Json } from '@srtdio/schemas';

const BRIEF_ID = '11111111-1111-1111-1111-111111111111';

const base: BuildPayloadInput = {
  title: 'Launch teaser',
  caption: 'Caption copy',
  platform: 'instagram',
  format: 'single_image',
  ownerUserId: '22222222-2222-2222-2222-222222222222',
  bucketId: '33333333-3333-3333-3333-333333333333',
  targetDate: '2026-06-20',
  origin: 'none',
  briefId: '',
};

describe('buildPostCreatePayload', () => {
  it('builds the snake_case payload with owner, bucket and target date', () => {
    const result = buildPostCreatePayload(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toMatchObject({
      title: 'Launch teaser',
      caption: 'Caption copy',
      platform: 'instagram',
      format: 'single_image',
      owner_user_id: '22222222-2222-2222-2222-222222222222',
      bucket_id: '33333333-3333-3333-3333-333333333333',
      target_date: '2026-06-20',
    });
    expect('origin' in (result.payload as object)).toBe(false);
    expect('brief_id' in (result.payload as object)).toBe(false);
  });

  it('includes origin and brief_id when origin is a brief', () => {
    const result = buildPostCreatePayload({ ...base, origin: 'brief', briefId: BRIEF_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toMatchObject({ origin: 'brief', brief_id: BRIEF_ID });
  });

  it('requires a brief_id when origin is a brief', () => {
    const result = buildPostCreatePayload({ ...base, origin: 'brief', briefId: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.briefId).toBeDefined();
  });

  it('omits owner_user_id and bucket_id when unset', () => {
    const result = buildPostCreatePayload({ ...base, ownerUserId: '', bucketId: '', targetDate: '' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('owner_user_id' in (result.payload as object)).toBe(false);
    expect('bucket_id' in (result.payload as object)).toBe(false);
    expect('target_date' in (result.payload as object)).toBe(false);
  });

  it('rejects a missing platform', () => {
    expect(buildPostCreatePayload({ ...base, platform: '' }).ok).toBe(false);
  });
});

describe('submitCreatePost', () => {
  const client = {} as Client;

  function deps(overrides: {
    versionIds?: string[];
    postCreate?: SubmitArgs['postCreate'];
    gallerySet?: SubmitArgs['gallerySet'];
  }): SubmitArgs {
    return {
      client,
      workspaceId: 'w1',
      payload: { title: 'T' } as Json,
      versionIds: overrides.versionIds ?? [],
      newTrace: () => 'tr',
      postCreate:
        overrides.postCreate ??
        (vi.fn(async () => ({ ok: true, data: 'post-1' }) as Result<string>)),
      gallerySet:
        overrides.gallerySet ??
        (vi.fn(async () => ({ ok: true, data: 'gallery' }) as Result<string>)),
    };
  }

  it('creates the post and binds the gallery in order when attachments exist', async () => {
    const d = deps({ versionIds: ['v1', 'v2'] });
    const result = await submitCreatePost(d);
    expect(result).toEqual({ ok: true, postId: 'post-1' });
    expect(d.postCreate).toHaveBeenCalledWith(client, {
      p_workspace_id: 'w1',
      p_payload: { title: 'T' },
      p_trace_id: 'tr',
    });
    expect(d.gallerySet).toHaveBeenCalledWith(client, {
      p_post_id: 'post-1',
      p_asset_version_ids: ['v1', 'v2'],
      p_trace_id: 'tr',
    });
  });

  it('does not bind a gallery when there are no attachments', async () => {
    const d = deps({ versionIds: [] });
    const result = await submitCreatePost(d);
    expect(result).toEqual({ ok: true, postId: 'post-1' });
    expect(d.gallerySet).not.toHaveBeenCalled();
  });

  it('surfaces a post_create failure and skips the gallery', async () => {
    const gallerySet = vi.fn(async () => ({ ok: true, data: 'g' }) as Result<string>);
    const d = deps({
      versionIds: ['v1'],
      postCreate: vi.fn(async () => ({ ok: false, error: { code: 'unknown', message: 'boom' } }) as Result<string>),
      gallerySet,
    });
    const result = await submitCreatePost(d);
    expect(result).toEqual({ ok: false, message: 'boom' });
    expect(gallerySet).not.toHaveBeenCalled();
  });
});

describe('initialCreateState (reset-on-open)', () => {
  it('resets every field, defaulting owner to the current user and format to the default', () => {
    expect(initialCreateState({ defaultFormat: 'text', currentUserId: 'me' })).toEqual({
      title: '',
      caption: '',
      platform: '',
      format: 'text',
      ownerUserId: 'me',
      bucketId: '',
      targetDate: '',
      origin: 'none',
      briefId: '',
      attachments: [],
    });
  });

  it('leaves the owner empty when there is no current user', () => {
    expect(initialCreateState({ defaultFormat: 'text', currentUserId: null }).ownerUserId).toBe('');
  });
});

interface SubmitArgs {
  client: Client;
  workspaceId: string;
  payload: Json;
  versionIds: readonly string[];
  newTrace: () => string;
  postCreate: (
    client: Client,
    args: { p_workspace_id: string; p_payload: Json; p_trace_id: string },
  ) => Promise<Result<string>>;
  gallerySet: (
    client: Client,
    args: { p_post_id: string; p_asset_version_ids: string[]; p_trace_id: string },
  ) => Promise<Result<string>>;
}
