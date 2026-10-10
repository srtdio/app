import { describe, expect, it } from 'vitest';
import type { PostCardFields } from '@srtdio/posts';
import {
  buildPickerSections,
  cursorAfter,
  hasMoreResults,
  isPostSelected,
  matchesLabel,
  olderApprovedFooter,
  parsePickerQuery,
  recentApprovedSince,
  draftsAllowed,
  pickerReads,
  searchStageFilter,
  shownOfLabel,
  togglePost,
} from '@/components/chat/post-picker';
import { isAgencySide, isClient } from '@/components/pages/pcs/roles';
import { WorkspaceMemberSchema } from '@srtdio/schemas';

function post(id: string, over: Partial<PostCardFields> = {}): PostCardFields {
  return {
    id,
    title: `Post ${id}`,
    platform: 'instagram',
    format: 'reel',
    stage: 'review',
    ...over,
  };
}

// Roles are resolved through the permission helper, never hardcoded here.
const roles: string[] = WorkspaceMemberSchema.shape.role.options;
const agency = roles.find((r) => isAgencySide(r)) ?? null;
const nonAgency = roles.find((r) => !isAgencySide(r)) ?? null;
// Built from its char code: chat files carry no literal hash sign.
const HASH = String.fromCharCode(35);

describe('parsePickerQuery', () => {
  it('reads bare digits as a post number and keeps the text match', () => {
    expect(parsePickerQuery('14', 'GBL')).toEqual({ text: '14', number: 14 });
  });

  it('strips this workspace key prefix, any case', () => {
    expect(parsePickerQuery('GBL-14', 'GBL')).toEqual({ text: 'GBL-14', number: 14 });
    expect(parsePickerQuery(' gbl-14 ', 'GBL')).toEqual({ text: 'gbl-14', number: 14 });
  });

  it('strips a leading hash sign', () => {
    expect(parsePickerQuery(`${HASH}14`, 'GBL')).toEqual({ text: `${HASH}14`, number: 14 });
  });

  it('treats words as text only', () => {
    expect(parsePickerQuery('holi', 'GBL')).toEqual({ text: 'holi', number: null });
  });

  it('does not strip another workspace key', () => {
    expect(parsePickerQuery('ABC-14', 'GBL')).toEqual({ text: 'ABC-14', number: null });
  });

  it('is null for blank input, and never yields number 0', () => {
    expect(parsePickerQuery('   ', 'GBL')).toBeNull();
    expect(parsePickerQuery('0', 'GBL')?.number).toBeNull();
    expect(parsePickerQuery('99999999999', null)?.number).toBeNull();
  });
});

describe('buildPickerSections', () => {
  const rows = { review: ['r'], approved: ['a'], parked: ['p'], rejected: ['x'], drafts: ['d'] };

  it('posts mode: waiting, approved (30 days), parked, rejected; never drafts', () => {
    const sections = buildPickerSections({ mode: 'posts', role: agency, ...rows });
    expect(sections.map((s) => s.key)).toEqual(['review', 'approved', 'parked', 'rejected']);
    expect(sections.map((s) => s.label)).toEqual([
      'Waiting on client',
      'Approved in the last 30 days',
      'Parked',
      'Rejected',
    ]);
  });

  it('posts mode says "Waiting on you" for the client and still never lists drafts', () => {
    const client = roles.find((r) => isClient(r)) ?? null;
    const sections = buildPickerSections({ mode: 'posts', role: client, ...rows });
    expect(sections.map((s) => s.key)).toEqual(['review', 'approved', 'parked', 'rejected']);
    expect(sections[0]?.label).toBe('Waiting on you');
  });

  it('drafts mode: one Drafts section, nothing else', () => {
    const sections = buildPickerSections({ mode: 'drafts', role: agency, ...rows });
    expect(sections.map((s) => [s.key, s.label])).toEqual([['draft', 'Drafts']]);
    expect(buildPickerSections({ mode: 'drafts', role: agency, ...rows, drafts: null })).toEqual(
      [],
    );
  });

  it('inline: waiting, approved, then Drafts only when drafts were read', () => {
    expect(
      buildPickerSections({ mode: 'inline', role: agency, ...rows }).map((s) => s.key),
    ).toEqual(['review', 'approved', 'draft']);
    expect(
      buildPickerSections({ mode: 'inline', role: agency, ...rows, drafts: null }).map(
        (s) => s.key,
      ),
    ).toEqual(['review', 'approved']);
  });

  it('drops empty sections', () => {
    const sections = buildPickerSections({
      mode: 'posts',
      role: agency,
      review: [],
      approved: ['a'],
      parked: [],
      rejected: ['x'],
      drafts: null,
    });
    expect(sections.map((s) => s.key)).toEqual(['approved', 'rejected']);
  });
});

describe('pickerReads', () => {
  it('brief mode reads briefs and never a post; post modes never read briefs', () => {
    expect(pickerReads('briefs')).toEqual({ posts: false, briefs: true });
    for (const mode of ['posts', 'drafts', 'inline'] as const) {
      expect(pickerReads(mode)).toEqual({ posts: true, briefs: false });
    }
  });
});

describe('draft gate and search stage rule', () => {
  it('drafts are allowed only for an agency-side viewer in a chat known to have no client', () => {
    expect(draftsAllowed(agency, false)).toBe(true);
    expect(draftsAllowed(agency, true)).toBe(false);
    expect(draftsAllowed(agency, null)).toBe(false);
    expect(draftsAllowed(nonAgency, false)).toBe(false);
    expect(draftsAllowed(null, false)).toBe(false);
  });

  it('posts mode excludes drafts for everyone, agency included', () => {
    expect(searchStageFilter('posts', true)).toEqual({ excludeStage: 'draft' });
    expect(searchStageFilter('posts', false)).toEqual({ excludeStage: 'draft' });
  });

  it('drafts mode searches drafts only', () => {
    expect(searchStageFilter('drafts', true)).toEqual({ stage: 'draft' });
  });

  it('inline excludes drafts unless they are allowed', () => {
    expect(searchStageFilter('inline', false)).toEqual({ excludeStage: 'draft' });
    expect(searchStageFilter('inline', true)).toEqual({});
  });
});

describe('labels', () => {
  it('footer omits at 0 and pluralises', () => {
    expect(olderApprovedFooter(0)).toBeNull();
    expect(olderApprovedFooter(1)).toBe(
      '1 older approved post · type a word or number to find one',
    );
    expect(olderApprovedFooter(212)).toBe(
      '212 older approved posts · type a word or number to find one',
    );
  });

  it('matches and paging text', () => {
    expect(matchesLabel(1)).toBe('1 match');
    expect(matchesLabel(120)).toBe('120 matches');
    expect(shownOfLabel(50, 120)).toBe('50 of 120');
    expect(hasMoreResults(50, 120)).toBe(true);
    expect(hasMoreResults(120, 120)).toBe(false);
  });

  it('recent window is 30 days back', () => {
    expect(recentApprovedSince(new Date('2026-09-28T00:00:00.000Z'))).toBe(
      '2026-08-29T00:00:00.000Z',
    );
  });
});

describe('cursorAfter', () => {
  it('is the (created_at, id) of the last row, or null for none', () => {
    expect(
      cursorAfter([
        { id: 'a', created_at: '2026-09-02T00:00:00Z' },
        { id: 'b', created_at: '2026-09-01T00:00:00Z' },
      ]),
    ).toEqual({ createdAt: '2026-09-01T00:00:00Z', id: 'b' });
    expect(cursorAfter([])).toBeNull();
  });
});

describe('togglePost', () => {
  it('adds a post when absent and removes it when present (by id)', () => {
    const a = post('a');
    const b = post('b');
    const afterAdd = togglePost([a], b);
    expect(afterAdd.map((p) => p.id)).toEqual(['a', 'b']);

    const afterRemove = togglePost(afterAdd, a);
    expect(afterRemove.map((p) => p.id)).toEqual(['b']);
  });

  it('does not mutate the input array', () => {
    const selected = [post('a')];
    togglePost(selected, post('b'));
    expect(selected.map((p) => p.id)).toEqual(['a']);
  });

  it('isPostSelected reflects membership by id', () => {
    expect(isPostSelected([post('a')], 'a')).toBe(true);
    expect(isPostSelected([post('a')], 'b')).toBe(false);
  });
});
