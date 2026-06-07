// Unit coverage for the mention parser. Pure and DB-free, so it runs under both
// the dedicated comments config and the default `pnpm test` run.

import { describe, expect, it } from 'vitest';
import { parseMentions } from '../../packages/comments/src/index';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('parseMentions', () => {
  it('returns an empty array when there are no tokens', () => {
    expect(parseMentions('no mentions here')).toEqual([]);
    expect(parseMentions('')).toEqual([]);
  });

  it('extracts a single @[user_id] token', () => {
    expect(parseMentions(`hi @[${A}] please review`)).toEqual([A]);
  });

  it('extracts multiple distinct ids in first-appearance order', () => {
    expect(parseMentions(`@[${B}] and @[${A}]`)).toEqual([B, A]);
  });

  it('de-duplicates repeated ids', () => {
    expect(parseMentions(`@[${A}] @[${A}] @[${A}]`)).toEqual([A]);
  });

  it('normalises ids to lowercase', () => {
    expect(parseMentions(`@[${A.toUpperCase()}]`)).toEqual([A]);
  });

  it('ignores malformed tokens', () => {
    expect(parseMentions('@[not-a-uuid] @user @[] @[123]')).toEqual([]);
    // A bare uuid without the @[...] wrapper is not a mention.
    expect(parseMentions(A)).toEqual([]);
  });

  it('parses a mention adjacent to surrounding punctuation', () => {
    expect(parseMentions(`(@[${A}]),`)).toEqual([A]);
  });
});
