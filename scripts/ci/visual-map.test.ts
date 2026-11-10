import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fileOfRequest,
  fragmentPath,
  mergeFragments,
  parseMap,
  readFragments,
  serializeMap,
  writeFragment,
} from './visual-map.ts';

const ROOT = '/repo';

describe('visual-map: request to file', () => {
  it('keeps src/ and packages/ files, strips origin, query and /@fs', () => {
    expect(fileOfRequest('http://localhost:4195/@fs/repo/src/components/A.tsx?t=1&v=2', ROOT)).toBe(
      'src/components/A.tsx',
    );
    expect(fileOfRequest('http://localhost:4195/@fs/repo/packages/posts/src/index.ts', ROOT)).toBe(
      'packages/posts/src/index.ts',
    );
    expect(fileOfRequest('http://127.0.0.1:4195/@fs/repo/src/a%20b.ts', ROOT)).toBe('src/a b.ts');
  });

  it('drops node_modules, virtual modules, the harness, other hosts and junk', () => {
    for (const u of [
      'http://localhost:4195/@fs/repo/node_modules/.vite/deps/react.js?v=1',
      'http://localhost:4195/node_modules/.vite/deps/react.js',
      'http://localhost:4195/@vite/client',
      'http://localhost:4195/@react-refresh',
      'http://localhost:4195/@id/__x00__virtual',
      'http://localhost:4195/main.tsx',
      'http://localhost:4195/@fs/elsewhere/src/a.ts',
      'https://link-preview.harness.test/src/a.ts',
      'not a url',
    ]) {
      expect(fileOfRequest(u, ROOT), u).toBeNull();
    }
  });
});

describe('visual-map: fragments and merge', () => {
  it('merges to the union per screen, keys and arrays sorted, stable', () => {
    const a = [
      { screen: 'pipeline', project: 'iphone-light', files: ['src/b.ts', 'src/a.ts'] },
      { screen: 'briefs', project: 'iphone-light', files: ['src/c.ts'] },
      { screen: 'pipeline', project: 'laptop-light', files: ['src/a.ts', 'src/z.ts'] },
    ];
    const merged = mergeFragments(a);
    expect(Object.keys(merged)).toEqual(['briefs', 'pipeline']);
    expect(merged.pipeline).toEqual(['src/a.ts', 'src/b.ts', 'src/z.ts']);
    expect(serializeMap(mergeFragments([...a].reverse()))).toBe(serializeMap(merged));
    const text = serializeMap(merged);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(parseMap(text)).toEqual(merged);
  });

  it('parseMap rejects anything but an object of string arrays', () => {
    expect(parseMap('[]')).toBeNull();
    expect(parseMap('{"a": [1]}')).toBeNull();
    expect(parseMap('nope')).toBeNull();
    expect(parseMap('{"a": ["src/x.ts"]}')).toEqual({ a: ['src/x.ts'] });
  });

  it('writes one fragment per screen per project and reads them back', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'visual-map-'));
    try {
      writeFragment(
        { screen: 'a b', project: 'iphone-light', files: ['src/y.ts', 'src/x.ts'] },
        dir,
      );
      writeFragment({ screen: 'a b', project: 'laptop-light', files: ['src/z.ts'] }, dir);
      const file = path.join(dir, fragmentPath('iphone-light', 'a b'));
      expect(JSON.parse(readFileSync(file, 'utf8')).files).toEqual(['src/x.ts', 'src/y.ts']);
      const map = mergeFragments(readFragments([path.join(dir, 'e2e/results/visual-map')]));
      expect(map).toEqual({ 'a b': ['src/x.ts', 'src/y.ts', 'src/z.ts'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
