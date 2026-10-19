import { describe, expect, it, vi } from 'vitest';
import {
  briefFormatOptions,
  buildBriefCreatePayload,
  initialBriefState,
  submitCreateBrief,
  type BuildBriefPayloadInput,
  type SubmitCreateBriefDeps,
} from '@/components/pages/CreateBriefSheet';
import { GENERIC_ERROR } from '@/lib/error-copy';
import type { Client, Result } from '@srtdio/rpc';
import type { CommentResult } from '@srtdio/comments';
import type { Json } from '@srtdio/schemas';

const base: BuildBriefPayloadInput = {
  title: 'Spring launch',
  objective: 'Drive signups for the spring drop',
  format: 'single_image',
  targetDate: '2026-07-01',
  versionIds: ['v1', 'v2'],
};

describe('buildBriefCreatePayload', () => {
  it('builds the snake_case payload with format, target date and version ids', () => {
    const result = buildBriefCreatePayload(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toMatchObject({
      title: 'Spring launch',
      objective: 'Drive signups for the spring drop',
      format_requested: 'single_image',
      target_date: '2026-07-01',
      attachment_asset_version_ids: ['v1', 'v2'],
    });
  });

  it('sends brand_requirements trimmed when given, and never reference_links', () => {
    const result = buildBriefCreatePayload({ ...base, brandRequirements: '  Navy only  ' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.payload as Record<string, unknown>).brand_requirements).toBe('Navy only');
    expect('reference_links' in (result.payload as object)).toBe(false);
  });

  it('omits brand_requirements when it is blank', () => {
    const result = buildBriefCreatePayload({ ...base, brandRequirements: '   ' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('brand_requirements' in (result.payload as object)).toBe(false);
  });

  it('omits format_requested when the format is Any', () => {
    const result = buildBriefCreatePayload({ ...base, format: '' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('format_requested' in (result.payload as object)).toBe(false);
  });

  it('omits target_date and attachment ids when unset', () => {
    const result = buildBriefCreatePayload({ ...base, targetDate: '', versionIds: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('target_date' in (result.payload as object)).toBe(false);
    expect('attachment_asset_version_ids' in (result.payload as object)).toBe(false);
  });

  it('requires a non-empty title and objective', () => {
    expect(buildBriefCreatePayload({ ...base, title: '   ' }).ok).toBe(false);
    expect(buildBriefCreatePayload({ ...base, objective: '' }).ok).toBe(false);
  });
});

describe('submitCreateBrief', () => {
  const client = {} as Client;

  function deps(overrides: {
    initialComment?: string;
    briefCreate?: SubmitCreateBriefDeps['briefCreate'];
    createComment?: SubmitCreateBriefDeps['createComment'];
  }): SubmitCreateBriefDeps {
    return {
      client,
      workspaceId: 'w1',
      payload: { title: 'T', objective: 'O' } as Json,
      initialComment: overrides.initialComment ?? '',
      newTrace: () => 'tr',
      briefCreate:
        overrides.briefCreate ??
        vi.fn(async () => ({ ok: true, data: 'brief-1' }) as Result<string>),
      createComment:
        overrides.createComment ??
        vi.fn(async () => ({ ok: true, data: 'comment-1' }) as CommentResult<string>),
    };
  }

  it('creates the brief and passes the payload + trace to brief_create', async () => {
    const d = deps({});
    const result = await submitCreateBrief(d);
    expect(result).toEqual({ ok: true, briefId: 'brief-1', noteFailed: false });
    expect(d.briefCreate).toHaveBeenCalledWith(client, {
      p_workspace_id: 'w1',
      p_payload: { title: 'T', objective: 'O' },
      p_trace_id: 'tr',
    });
  });

  it('seeds the thread via createComment with entity_type brief and the new brief id', async () => {
    const createComment = vi.fn(
      async () => ({ ok: true, data: 'comment-1' }) as CommentResult<string>,
    );
    const d = deps({ initialComment: '  Welcome aboard  ', createComment });
    const result = await submitCreateBrief(d);
    expect(result).toEqual({ ok: true, briefId: 'brief-1', noteFailed: false });
    expect(createComment).toHaveBeenCalledWith(client, {
      workspace_id: 'w1',
      entity_type: 'brief',
      entity_id: 'brief-1',
      body: 'Welcome aboard',
      trace_id: 'tr',
    });
  });

  it('does not seed a comment when the initial comment is empty', async () => {
    const createComment = vi.fn(async () => ({ ok: true, data: 'c' }) as CommentResult<string>);
    const d = deps({ initialComment: '   ', createComment });
    await submitCreateBrief(d);
    expect(createComment).not.toHaveBeenCalled();
  });

  it('still resolves when the seed comment fails (best-effort), flagging noteFailed', async () => {
    const createComment = vi.fn(
      async () =>
        ({ ok: false, error: { code: 'unknown', message: 'seed boom' } }) as CommentResult<string>,
    );
    const d = deps({ initialComment: 'note', createComment });
    const result = await submitCreateBrief(d);
    expect(result).toEqual({ ok: true, briefId: 'brief-1', noteFailed: true });
  });

  it('surfaces a brief_create failure and skips the comment', async () => {
    const createComment = vi.fn(async () => ({ ok: true, data: 'c' }) as CommentResult<string>);
    const d = deps({
      initialComment: 'note',
      briefCreate: vi.fn(
        async () => ({ ok: false, error: { code: 'unknown', message: 'boom' } }) as Result<string>,
      ),
      createComment,
    });
    const result = await submitCreateBrief(d);
    expect(result).toEqual({ ok: false, message: GENERIC_ERROR });
    expect(createComment).not.toHaveBeenCalled();
  });
});

describe('initialBriefState (reset-on-open)', () => {
  it('clears every field including attachments and the initial comment', () => {
    expect(initialBriefState()).toEqual({
      title: '',
      objective: '',
      brandRequirements: '',
      format: '',
      targetDate: '',
      initialComment: '',
      attachments: [],
    });
  });
});

describe('briefFormatOptions', () => {
  it("offers Any plus the workspace platform's formats, never link", () => {
    expect(briefFormatOptions('linkedin').map((o) => o.value)).toEqual([
      '',
      'text',
      'single_image',
      'carousel',
      'video',
    ]);
    expect(briefFormatOptions('facebook').map((o) => o.value)).not.toContain('link');
    expect(briefFormatOptions('youtube_shorts')).toEqual([
      { value: '', label: 'Any' },
      { value: 'short', label: 'Short' },
    ]);
  });

  it("uses the platform's wording", () => {
    expect(briefFormatOptions('x').find((o) => o.value === 'single_image')?.label).toBe('Image');
  });

  it('offers only Any before the platform resolves', () => {
    expect(briefFormatOptions(null)).toEqual([{ value: '', label: 'Any' }]);
  });
});
