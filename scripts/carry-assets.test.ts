import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_DIST_FILES,
  RETAIN_DAYS,
  countFiles,
  filesToDrop,
  type HistoryEntry,
} from './carry-assets.ts';

// The Pages file cap: carried assets are kept 2 days, and past 19,000 files in
// dist/ the oldest carried files go first. Current-build files are never in
// the carried list, so they can never be dropped.

const carried = (path: string, firstSeen: string): HistoryEntry => ({ path, firstSeen });

describe('retention and ceiling', () => {
  it('keeps carried assets for 2 days under a 19,000-file ceiling', () => {
    expect(RETAIN_DAYS).toBe(2);
    expect(MAX_DIST_FILES).toBe(19_000);
  });
});

describe('filesToDrop', () => {
  const old = [
    carried('assets/c.js', '2026-11-01T10:00:00Z'),
    carried('assets/a.js', '2026-10-31T10:00:00Z'),
    carried('assets/b.js', '2026-11-01T09:00:00Z'),
    carried('assets/d.js', '2026-10-31T10:00:00Z'),
  ];

  it('drops nothing at or under the ceiling', () => {
    expect(filesToDrop(19_000, old)).toEqual([]);
    expect(filesToDrop(18_500, old)).toEqual([]);
  });

  it('drops just enough, oldest first (ties by path), to reach the ceiling', () => {
    expect(filesToDrop(19_001, old)).toEqual(['assets/a.js']);
    expect(filesToDrop(19_003, old)).toEqual(['assets/a.js', 'assets/d.js', 'assets/b.js']);
  });

  it('never drops more than the carried files: current-build files stay', () => {
    // 25,000 files with only 4 carried: the build's own files are never listed.
    const drop = filesToDrop(25_000, old);
    expect(drop).toHaveLength(4);
    expect(new Set(drop)).toEqual(new Set(old.map((e) => e.path)));
    expect(filesToDrop(25_000, [])).toEqual([]);
  });

  it('honours a custom ceiling', () => {
    expect(filesToDrop(5, old, 3)).toEqual(['assets/a.js', 'assets/d.js']);
  });
});

describe('countFiles', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('counts every file in every folder, not only assets/', () => {
    dir = mkdtempSync(join(tmpdir(), 'carry-assets-'));
    mkdirSync(join(dir, 'assets'));
    mkdirSync(join(dir, 'legal', 'deep'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '');
    writeFileSync(join(dir, 'assets', 'a.js'), '');
    writeFileSync(join(dir, 'assets', 'b.css'), '');
    writeFileSync(join(dir, 'legal', 'privacy.html'), '');
    writeFileSync(join(dir, 'legal', 'deep', 'x.txt'), '');
    expect(countFiles(dir)).toBe(5);
  });
});
