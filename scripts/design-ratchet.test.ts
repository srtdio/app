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
  offGrid: 5,
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
  handTap: 4,
  fullWidthButton: 1,
  designDisables: 1,
};

describe('design ratchet: per-metric counts', () => {
  for (const metric of METRIC_NAMES) {
    it(`${metric}`, () => {
      // zArbitrary shares the zValues fixture (z-[60] is both).
      const fixture = metric === 'zArbitrary' ? 'zValues' : metric;
      expect(countsOf(fixture)[metric]).toBe(EXPECTED[metric]);
    });
  }

  it('zValues fixture counts z-[60] as arbitrary', () => {
    expect(countsOf('zValues').zArbitrary).toBe(1);
  });

  it('offGrid allows px divisible by 4 and 0.5 on sizes', () => {
    const c = countHits(
      scanSource('src/a.tsx', '<div className="h-0.5 w-5 p-1 m-[8px] gap-[2px]" />'),
    );
    expect(c.offGrid).toBe(0);
    expect(c.arbitraryPx).toBe(2);
  });

  it('offGrid counts the spacing off-steps (p/m/gap/space 0.5, 5, 7; CLAUDE.md Spacing)', () => {
    const c = countHits(
      scanSource('src/a.tsx', '<div className="p-0.5 gap-5 -mt-7 md:space-y-5 h-5 w-7" />'),
    );
    expect(c.offGrid).toBe(4);
  });

  it('handTap counts the VISIBLE height: a primitive shrunk by className, or a small first child', () => {
    const shrunk = countHits(
      scanSource('src/a.tsx', '<Button onClick={f} className="h-8">Go</Button>'),
    );
    expect(shrunk.handTap).toBe(1);
    const face = countHits(
      scanSource('src/a.tsx', '<IconButton label="x"><span className="h-6 w-6" /></IconButton>'),
    );
    expect(face.handTap).toBe(1);
    const fine = countHits(
      scanSource(
        'src/a.tsx',
        '<IconButton label="x"><IconStar size={ICON_SIZE.control} /></IconButton>',
      ),
    );
    expect(fine.handTap).toBe(0);
  });

  it('exitMix counts X + < exits whatever their labels say, not remove/clear X or previous <', () => {
    const exits = [
      '<div>',
      '  <IconButton label="Done"><IconX /></IconButton>',
      '  <IconButton label="Go up"><IconChevronLeft /></IconButton>',
      '</div>',
    ].join('\n');
    expect(countHits(scanSource('src/a.tsx', exits)).exitMix).toBe(1);
    const allowed = [
      '<div>',
      '  <IconButton label="Clear search"><IconX /></IconButton>',
      '  <IconButton label="Previous image"><IconChevronLeft /></IconButton>',
      '  <IconButton label="Back"><IconChevronLeft /></IconButton>',
      '</div>',
    ].join('\n');
    expect(countHits(scanSource('src/a.tsx', allowed)).exitMix).toBe(0);
  });

  it('ui/Text.tsx is the role table: its leading/tracking are not counted', () => {
    const src = "export const R = { display: 'text-3xl tracking-tight leading-9' };";
    expect(countHits(scanSource('src/components/ui/Text.tsx', src)).tracking).toBe(0);
    expect(countHits(scanSource('src/components/pages/X.tsx', src)).tracking).toBe(1);
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
