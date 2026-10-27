import { describe, expect, it } from 'vitest';
import { resolveNext, safeNextPath, withNext } from './next-param';

describe('safeNextPath (open-redirect guard)', () => {
  it.each(['/invite/accept/abc', '/pipeline', '/posts/1?tab=comments', '/a/b#c'])(
    'keeps the in-app path %j',
    (path) => {
      expect(safeNextPath(path)).toBe(path);
    },
  );

  it.each([
    null,
    undefined,
    '',
    'pipeline',
    '//evil.test',
    '//evil.test/invite/accept/x',
    '/\\evil.test',
    '/\t/evil.test',
    '/\n/evil.test',
    '/ /evil.test',
    'https://evil.test',
    'http://evil.test/pipeline',
    'javascript:alert(1)',
    ' /pipeline',
  ])('rejects %j', (raw) => {
    expect(safeNextPath(raw)).toBe('');
  });
});

describe('withNext', () => {
  it('appends an encoded safe destination', () => {
    expect(withNext('/signin', '/invite/accept/abc')).toBe('/signin?next=%2Finvite%2Faccept%2Fabc');
  });

  it('drops an unsafe destination', () => {
    expect(withNext('/signin', '//evil.test')).toBe('/signin');
    expect(withNext('/signin', 'https://evil.test')).toBe('/signin');
    expect(withNext('/signin', '')).toBe('/signin');
  });
});

describe('resolveNext', () => {
  it('prefers a safe ?next= over the RequireAuth state', () => {
    expect(resolveNext('/invite/accept/a', { from: '/briefs' })).toBe('/invite/accept/a');
  });

  it('falls back to the RequireAuth { from } state', () => {
    expect(resolveNext(null, { from: '/invite/accept/a' })).toBe('/invite/accept/a');
  });

  it('falls back to the state when ?next= is unsafe', () => {
    expect(resolveNext('//evil.test', { from: '/pipeline' })).toBe('/pipeline');
  });

  it.each([null, undefined, 'x', { from: 3 }, { from: '//evil.test' }, {}])(
    'is empty for state %j with no ?next=',
    (state) => {
      expect(resolveNext(null, state)).toBe('');
    },
  );
});
