import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compare,
  countHits,
  lowerBaseline,
  METRIC_NAMES,
  run,
  scanSource,
  type Counts,
  type Metric,
} from './design-ratchet.ts';

const FIXTURES = fileURLToPath(new URL('./__fixtures__/design-ratchet/src/', import.meta.url));

function countsOf(metric: string): Counts {
  const src = readFileSync(join(FIXTURES, `${metric}.tsx`), 'utf8');
  return countHits(scanSource(`src/${metric}.tsx`, src));
}

// One fixture per metric; the number is what that fixture is built to hold.
const EXPECTED: Record<Metric, number> = {
  arbitraryPx: 3,
  offGrid: 4,
  zValues: 3,
  zArbitrary: 1,
  leading: 3,
  tracking: 2,
  borderWidth: 3,
  cardPadding: 2,
  dotSizes: 2,
  iconSizes: 3,
  iconSizeLiteral: 2,
  rawImg: 2,
  threeDots: 2,
  keyIndex: 3,
  outlineNone: 2,
  nowrap: 1,
  exitMix: 1,
  handTap: 2,
  fullWidthButton: 1,
  designDisables: 1,
};

describe('design ratchet: per-metric counts', () => {
  for (const metric of METRIC_NAMES) {
    it(`${metric}`, () => {
      expect(countsOf(metric)[metric]).toBe(EXPECTED[metric]);
    });
  }

  it('zValues fixture counts z-[60] as arbitrary', () => {
    expect(countsOf('zValues').zArbitrary).toBe(1);
  });

  it('offGrid allows 0.5 and px divisible by 4', () => {
    const c = countHits(scanSource('src/a.tsx', '<div className="p-0.5 m-[8px] gap-[2px]" />'));
    expect(c.offGrid).toBe(0);
    expect(c.arbitraryPx).toBe(2);
  });

  it('ignores import paths', () => {
    const c = countHits(
      scanSource('src/a.ts', "import x from '../...';\nexport const k = 'lit-card';"),
    );
    expect(c.threeDots).toBe(0);
  });
});

function zeroCounts(): Counts {
  const c = {} as Counts;
  for (const m of METRIC_NAMES) c[m] = 0;
  return c;
}

describe('design ratchet: baseline rules', () => {
  it('compare flags raises and lowers', () => {
    const counts = { ...zeroCounts(), leading: 3, tracking: 1 };
    const base = { ...zeroCounts(), leading: 2, tracking: 2 };
    const cmp = compare(counts, base);
    expect(cmp.raised).toEqual([{ metric: 'leading', count: 3, baseline: 2 }]);
    expect(cmp.lowered).toEqual([{ metric: 'tracking', count: 1, baseline: 2 }]);
  });

  it('lowerBaseline refuses to raise', () => {
    const counts = { ...zeroCounts(), leading: 3 };
    expect(() => lowerBaseline(counts, { ...zeroCounts(), leading: 2 })).toThrow(
      /Refusing to raise/,
    );
  });

  it('lowerBaseline lowers', () => {
    const counts = { ...zeroCounts(), leading: 1 };
    expect(lowerBaseline(counts, { ...zeroCounts(), leading: 5 }).leading).toBe(1);
  });
});

describe('design ratchet: CLI', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function repoWith(metric: string): { root: string; baselinePath: string } {
    const root = mkdtempSync(join(tmpdir(), 'design-ratchet-'));
    dirs.push(root);
    mkdirSync(join(root, 'src'));
    cpSync(join(FIXTURES, `${metric}.tsx`), join(root, 'src', `${metric}.tsx`));
    return { root, baselinePath: join(root, 'baseline.json') };
  }

  function exec(argv: string[], root: string, baselinePath: string) {
    const out: string[] = [];
    const err: string[] = [];
    const code = run(argv, {
      root,
      baselinePath,
      log: (l) => out.push(l),
      error: (l) => err.push(l),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('passes at baseline', () => {
    const { root, baselinePath } = repoWith('leading');
    writeFileSync(baselinePath, JSON.stringify({ ...zeroCounts(), leading: 3 }));
    expect(exec([], root, baselinePath).code).toBe(0);
  });

  it('fails a raise, naming the metric, the file:line and the fix', () => {
    const { root, baselinePath } = repoWith('leading');
    writeFileSync(baselinePath, JSON.stringify({ ...zeroCounts(), leading: 2 }));
    const r = exec([], root, baselinePath);
    expect(r.code).toBe(1);
    expect(r.err).toContain('leading rose 2 -> 3');
    expect(r.err).toMatch(/src\/leading\.tsx:\d+/);
    expect(r.err).toContain('Use instead:');
  });

  it('passes a lowering and says the baseline can go down', () => {
    const { root, baselinePath } = repoWith('leading');
    writeFileSync(baselinePath, JSON.stringify({ ...zeroCounts(), leading: 5 }));
    const r = exec([], root, baselinePath);
    expect(r.code).toBe(0);
    expect(r.out).toContain('can lower baseline: metric leading -> 3');
  });

  it('--update refuses to raise and leaves the file alone', () => {
    const { root, baselinePath } = repoWith('leading');
    const before = JSON.stringify({ ...zeroCounts(), leading: 1 });
    writeFileSync(baselinePath, before);
    const r = exec(['--update'], root, baselinePath);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Refusing to raise');
    expect(readFileSync(baselinePath, 'utf8')).toBe(before);
  });

  it('--update lowers', () => {
    const { root, baselinePath } = repoWith('leading');
    writeFileSync(baselinePath, JSON.stringify({ ...zeroCounts(), leading: 9 }));
    expect(exec(['--update'], root, baselinePath).code).toBe(0);
    const next = JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, number>;
    expect(next.leading).toBe(3);
  });

  it('--verbose lists file:line per metric', () => {
    const { root, baselinePath } = repoWith('keyIndex');
    writeFileSync(baselinePath, JSON.stringify({ ...zeroCounts(), keyIndex: 3 }));
    const r = exec(['--verbose'], root, baselinePath);
    expect(r.out).toMatch(/src\/keyIndex\.tsx:\d+ {2}key=\{i\}/);
  });
});
