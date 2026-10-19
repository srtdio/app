import { describe, expect, it, vi } from 'vitest';
import {
  BRIEF_FILTER_DEFAULT,
  briefListParams,
  listWorkspaceBriefs,
  parseBriefFilter,
} from '@/lib/brief-list';

describe('parseBriefFilter (FT24, default Open)', () => {
  it('defaults to Open when the URL names no chip or an unknown one', () => {
    expect(BRIEF_FILTER_DEFAULT).toBe('open');
    expect(parseBriefFilter(null)).toBe('open');
    expect(parseBriefFilter('archived')).toBe('open');
  });

  it('reads all, open and closed', () => {
    expect(parseBriefFilter('all')).toBe('all');
    expect(parseBriefFilter('closed')).toBe('closed');
  });
});

describe('briefListParams', () => {
  it('writes status and q, leaving out the defaults, keeping other params', () => {
    const base = new URLSearchParams('keep=1');
    expect(briefListParams(base, 'closed', 'reel').toString()).toBe('keep=1&status=closed&q=reel');
    expect(briefListParams(new URLSearchParams('status=closed&q=x'), 'open', '').toString()).toBe(
      '',
    );
  });
});

describe('listWorkspaceBriefs (FT25)', () => {
  it('reads pages by workspace until a short page', async () => {
    const readPage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: [1, 2] })
      .mockResolvedValueOnce({ ok: true, data: [3] });
    const result = await listWorkspaceBriefs('w1', 2, readPage);
    expect(result).toEqual({ ok: true, data: [1, 2, 3] });
    expect(readPage.mock.calls).toEqual([
      [{ workspaceId: 'w1', limit: 2, offset: 0 }],
      [{ workspaceId: 'w1', limit: 2, offset: 2 }],
    ]);
  });

  it('fails the whole read when a page fails', async () => {
    const error = { code: 'unknown', message: 'boom' };
    const readPage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: [1, 2] })
      .mockResolvedValueOnce({ ok: false, error });
    expect(await listWorkspaceBriefs('w1', 2, readPage)).toEqual({ ok: false, error });
  });
});
