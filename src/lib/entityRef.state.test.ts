import { describe, expect, it } from 'vitest';
import { knownRefId, refOpenState } from '@/lib/entityRef';

describe('knownRefId', () => {
  it('returns the id carried for exactly this kind and ref (any case, leading zeros)', () => {
    const state = refOpenState('post', 'GBL', 12, 'p-12');
    expect(knownRefId(state, 'post', 'gbl-12')).toBe('p-12');
    expect(knownRefId(state, 'post', 'GBL-012')).toBe('p-12');
  });

  it('ignores state made for another ref, another kind, or malformed state', () => {
    const state = refOpenState('post', 'GBL', 12, 'p-12');
    expect(knownRefId(state, 'post', 'gbl-13')).toBeNull();
    expect(knownRefId(state, 'post', 'abc-12')).toBeNull();
    expect(knownRefId(state, 'brief', 'gbl-12')).toBeNull();
    expect(knownRefId(state, 'post', undefined)).toBeNull();
    expect(knownRefId(null, 'post', 'gbl-12')).toBeNull();
    const noId = { entityRef: { kind: 'post', key: 'GBL', number: 12 } };
    expect(knownRefId(noId, 'post', 'gbl-12')).toBeNull();
  });
});
