import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildBriefCreatePayload,
  initialBriefState,
  submitCreateBrief,
  type BuildBriefPayloadInput,
  type SubmitCreateBriefDeps,
} from '@/components/pages/CreateBriefSheet';
import type { Client, Result } from '@srtdio/rpc';
import type { Json } from '@srtdio/schemas';

const base: BuildBriefPayloadInput = {
  title: 'Spring launch',
  objective: 'Drive signups for the spring drop',
  targetDate: '2026-07-01',
  versionIds: ['v1', 'v2'],
};

describe('buildBriefCreatePayload', () => {
  it('builds the snake_case payload with target date and version ids', () => {
    const result = buildBriefCreatePayload(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toEqual({
      title: 'Spring launch',
      objective: 'Drive signups for the spring drop',
      target_date: '2026-07-01',
      attachment_asset_version_ids: ['v1', 'v2'],
    });
  });

  it('never sends format_requested, brand_requirements or reference_links (9 Nov 2026)', () => {
    const result = buildBriefCreatePayload(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const gone of ['format_requested', 'brand_requirements', 'reference_links']) {
      expect(gone in (result.payload as object)).toBe(false);
    }
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

describe('submitCreateBrief (one write)', () => {
  const client = {} as Client;

  function deps(overrides: {
    briefCreate?: SubmitCreateBriefDeps['briefCreate'];
  }): SubmitCreateBriefDeps {
    return {
      client,
      workspaceId: 'w1',
      payload: { title: 'T', objective: 'O' } as Json,
      newTrace: () => 'tr',
      briefCreate:
        overrides.briefCreate ??
        vi.fn(async () => ({ ok: true, data: 'brief-1' }) as Result<string>),
    };
  }

  it('creates the brief with exactly one write: brief_create with the payload + trace', async () => {
    const d = deps({});
    const result = await submitCreateBrief(d);
    expect(result).toEqual({ ok: true, briefId: 'brief-1' });
    expect(d.briefCreate).toHaveBeenCalledTimes(1);
    expect(d.briefCreate).toHaveBeenCalledWith(client, {
      p_workspace_id: 'w1',
      p_payload: { title: 'T', objective: 'O' },
      p_trace_id: 'tr',
    });
  });

  it('surfaces a brief_create failure as plain copy', async () => {
    const d = deps({
      briefCreate: vi.fn(
        async () => ({ ok: false, error: { code: 'unknown', message: 'boom' } }) as Result<string>,
      ),
    });
    const result = await submitCreateBrief(d);
    expect(result).toEqual({ ok: false, message: "Couldn't create the brief. Try again." });
  });

  it('the sheet no longer seeds a comment or reads the platform (no second write)', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./CreateBriefSheet.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).not.toMatch(/createComment|initialComment|noteFailed|useWorkspacePlatform/);
  });
});

describe('initialBriefState (reset-on-open)', () => {
  it('clears every field including attachments', () => {
    expect(initialBriefState()).toEqual({
      title: '',
      objective: '',
      targetDate: '',
      attachments: [],
    });
  });
});
