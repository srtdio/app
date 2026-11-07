import { describe, expect, it } from 'vitest';
import {
  blankImports,
  compareLighting,
  countRoles,
  diffOccurrences,
  formatTable,
  isCounted,
  scanFiles,
  scanSource,
  stripComments,
  type FileMap,
} from './lighting-guard.ts';

const NONE = {};

function counts(files: FileMap) {
  return countRoles(scanFiles(files));
}

describe('isCounted', () => {
  it('counts app ts/tsx and skips tests, home and other folders', () => {
    expect(isCounted('src/components/pages/BriefCard.tsx')).toBe(true);
    expect(isCounted('src/lib/plan-tab.ts')).toBe(true);
    expect(isCounted('src/components/pages/BriefCard.test.tsx')).toBe(false);
    expect(isCounted('src/components/pages/__tests__/x.tsx')).toBe(false);
    expect(isCounted('src/components/home/Hero.tsx')).toBe(false);
    expect(isCounted('src/index.css')).toBe(false);
    expect(isCounted('scripts/design-ratchet.ts')).toBe(false);
    expect(isCounted('src/vite-env.d.ts')).toBe(false);
  });
});

describe('scanSource', () => {
  it('counts each lit-* class as its role, variants included', () => {
    const src = [
      `const a = 'rounded-xl border lit-card';`,
      `const b = 'hover:lit-hover focus-visible:lit-focus-inset lit-card-muted';`,
    ].join('\n');
    const occ = scanSource('src/a.tsx', src);
    expect(occ.map((o) => o.role)).toEqual([
      'lit-card',
      'lit-hover',
      'lit-focus-inset',
      'lit-card-muted',
    ]);
    expect(occ[2]).toMatchObject({ line: 2, token: 'focus-visible:lit-focus-inset' });
  });

  it('never counts a lit- glued to a word or dash, or a lone prefix', () => {
    const src = `const a = 'data-lit-card unlit-card lit-';\nconst b = \`lit-\${x}\`;`;
    expect(scanSource('src/a.tsx', src)).toEqual([]);
  });

  it('ignores comments but keeps strings and line numbers', () => {
    const src = [
      '// cards are lit-card',
      '/* lit-header',
      '   lit-media */',
      `const url = 'https://x.test/a'; const c = 'lit-pill';`,
      `const t = \`\${a ? 'lit-selected' : 'lit-card'} // not a comment lit-badge\`;`,
    ].join('\n');
    const occ = scanSource('src/a.tsx', src);
    expect(occ.map((o) => `${o.line}:${o.role}`)).toEqual([
      '4:lit-pill',
      '5:lit-selected',
      '5:lit-card',
      '5:lit-badge',
    ]);
  });

  it('counts a part use as the role it always paints, never in the part itself or an import', () => {
    const src = [
      `import { Card, cardSurface } from '@/components/ui/Card';`,
      `import { HeaderBar } from '@/components/ui/HeaderBar';`,
      'const a = (',
      '  <Card title="x">',
      '    <HeaderBar title="y" />',
      '  </Card>',
      ');',
      `const b = cardSurface();`,
      'const c = <Cardigan />;',
    ].join('\n');
    const roles = scanSource('src/a.tsx', src).map((o) => `${o.line}:${o.role}:${o.kind}`);
    expect(roles).toEqual(['4:lit-card:part', '5:lit-header:part', '8:lit-card:part']);
    expect(scanSource('src/components/ui/Card.tsx', 'const x = cardSurface();')).toEqual([]);
  });

  it('counts a JSX part use whose props start on the next line', () => {
    const occ = scanSource('src/a.tsx', 'const a = (\n  <ListCard\n    title="x"\n  />\n);');
    expect(occ).toMatchObject([{ role: 'lit-card', line: 2, kind: 'part' }]);
  });
});

describe('stripComments / blankImports', () => {
  it('keeps every newline', () => {
    const src = 'a\n/* b\nc */\nd // e\nf';
    expect(stripComments(src).split('\n')).toHaveLength(5);
    const lines = blankImports(`import {\n  A,\n} from 'a';\nx`).split('\n');
    expect(lines.map((l) => l.trim())).toEqual(['', '', '', 'x']);
    expect(lines.map((l) => l.length)).toEqual([8, 4, 11, 1]);
  });
});

describe('compareLighting', () => {
  const main: FileMap = {
    'src/a.tsx': `const a = 'lit-card lit-header';`,
    'src/b.tsx': `const b = 'lit-card lit-media';`,
  };

  it('passes when every role keeps its count', () => {
    const cmp = compareLighting(main, { ...main }, NONE, NONE);
    expect(cmp.drops).toEqual([]);
    expect(cmp.rows.find((r) => r.role === 'lit-card')).toMatchObject({ main: 2, branch: 2 });
  });

  it('fails when a role drops, naming the role and both counts', () => {
    const branch = { ...main, 'src/a.tsx': `const a = 'lit-card';` };
    const cmp = compareLighting(main, branch, NONE, NONE);
    expect(cmp.drops).toEqual([
      { role: 'lit-header', main: 1, branch: 0, allowed: 0, ok: false },
    ]);
    expect(formatTable(cmp.rows).join('\n')).toContain('DROP');
  });

  it('passes when a role only rises or a new role appears', () => {
    const branch = { ...main, 'src/c.tsx': `const c = 'lit-card lit-today';` };
    expect(compareLighting(main, branch, NONE, NONE).drops).toEqual([]);
  });

  it('allows what a retired file loses, and only that', () => {
    const branch = { 'src/a.tsx': main['src/a.tsx']! };
    const retired = { 'src/b.tsx': 'view removed' };
    const ok = compareLighting(main, branch, retired, NONE);
    expect(ok.drops).toEqual([]);
    expect(ok.allowances).toEqual([
      { file: 'src/b.tsx', role: 'lit-card', count: 1, why: 'view removed' },
      { file: 'src/b.tsx', role: 'lit-media', count: 1, why: 'view removed' },
    ]);
    // A drop in another file is still a drop.
    const worse = compareLighting(main, { 'src/a.tsx': `const a = 'lit-card';` }, retired, NONE);
    expect(worse.drops.map((r) => r.role)).toEqual(['lit-header']);
  });

  it('allows a retired file emptied to a stub, not only a deleted one', () => {
    const branch = { ...main, 'src/b.tsx': 'export const x = 1;' };
    expect(compareLighting(main, branch, { 'src/b.tsx': 'stub' }, NONE).drops).toEqual([]);
  });

  it('caps an explained drop at its count', () => {
    const before: FileMap = { 'src/a.tsx': `'lit-pill' + 'lit-pill' + 'lit-pill'` };
    const after: FileMap = { 'src/a.tsx': `'x'` };
    const one = { 'src/a.tsx': { 'lit-pill': { count: 1, why: 'merged' } } };
    const three = { 'src/a.tsx': { 'lit-pill': { count: 3, why: 'merged' } } };
    expect(compareLighting(before, after, NONE, one).drops).toMatchObject([
      { role: 'lit-pill', main: 3, branch: 0, allowed: 1 },
    ]);
    expect(compareLighting(before, after, NONE, three).drops).toEqual([]);
  });

  it('keeps the count when a hand-built frame moves onto the part', () => {
    const before: FileMap = { 'src/a.tsx': `<div className="rounded-xl border lit-card" />` };
    const after: FileMap = { 'src/a.tsx': `<Card title="x" />` };
    expect(compareLighting(before, after, NONE, NONE).drops).toEqual([]);
    expect(counts(after)).toEqual({ 'lit-card': 1 });
  });

  it('skips tests and home on both sides', () => {
    const before: FileMap = { 'src/a.test.tsx': `'lit-card'`, 'src/components/home/H.tsx': `'lit-card'` };
    expect(compareLighting(before, {}, NONE, NONE).drops).toEqual([]);
  });
});

describe('diffOccurrences', () => {
  it('lists only the occurrences added or removed, by file and line', () => {
    const before: FileMap = { 'src/a.tsx': `'lit-card'\n'lit-header'\n'lit-media'` };
    const after: FileMap = { 'src/a.tsx': `\n'lit-card'\n'lit-media'\n'lit-pill'` };
    const changes = diffOccurrences(before, after).map(
      (c) => `${c.sign} ${c.occ.file}:${c.occ.line} ${c.occ.token}`,
    );
    expect(changes).toEqual(['- src/a.tsx:2 lit-header', '+ src/a.tsx:4 lit-pill']);
  });

  it('lists every class of a deleted file as removed', () => {
    const changes = diffOccurrences({ 'src/b.tsx': `'lit-card lit-drop'` }, {});
    expect(changes.map((c) => `${c.sign}${c.occ.role}`)).toEqual(['-lit-card', '-lit-drop']);
  });
});
