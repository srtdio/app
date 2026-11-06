import { describe, expect, it } from 'vitest';
import { runHook, type HookDeps } from './claude-design-hook.ts';

const ROOT = '/repo';
const FILE = 'src/components/pages/Thing.tsx';

/** The JSON Claude Code sends a PostToolUse hook on stdin. */
function stdin(filePath: string, tool = 'Edit'): string {
  return JSON.stringify({
    session_id: 'test',
    hook_event_name: 'PostToolUse',
    tool_name: tool,
    tool_input: { file_path: filePath },
  });
}

function deps(current: string, base: string, extra: Partial<HookDeps> = {}): HookDeps {
  return {
    root: ROOT,
    readCurrent: () => current,
    readBase: () => base,
    ...extra,
  };
}

const CLEAN_OLD = `export function Thing() {\n  return <div className="p-4" />;\n}\n`;
const CLEAN_NEW = `export function Thing() {\n  return <div className="p-4 gap-2" />;\n}\n`;
const BAD_NEW = `export function Thing() {\n  return <div className="p-[18px]" />;\n}\n`;
const OLD_BAD = `export function Thing() {\n  return <div className="p-[18px]" />;\n}\n`;
const OLD_BAD_MOVED = `// moved down a line\nexport function Thing() {\n  const x = 1;\n  return <div className="p-[18px]" data-x={x} />;\n}\n`;

describe('claude design hook', () => {
  it('clean edit exits 0', () => {
    const r = runHook(stdin(`${ROOT}/${FILE}`), deps(CLEAN_NEW, CLEAN_OLD));
    expect(r.code).toBe(0);
    expect(r.stderr).toEqual([]);
  });

  it('new p-[18px] exits 2 with the fix', () => {
    const r = runHook(stdin(`${ROOT}/${FILE}`, 'Write'), deps(BAD_NEW, CLEAN_OLD));
    expect(r.code).toBe(2);
    const text = r.stderr.join('\n');
    expect(text).toContain(`${FILE}:2  arbitraryPx: p-[18px]`);
    expect(text).toContain('Use instead:');
    expect(text).toContain('offGrid');
  });

  it('a brand new file is compared with an empty base', () => {
    const r = runHook(stdin(`${ROOT}/${FILE}`, 'Write'), deps(BAD_NEW, ''));
    expect(r.code).toBe(2);
  });

  it('an unchanged old violation exits 0, even when its line moves', () => {
    const r = runHook(stdin(`${ROOT}/${FILE}`, 'MultiEdit'), deps(OLD_BAD_MOVED, OLD_BAD));
    expect(r.code).toBe(0);
  });

  it('a second copy of an old violation is new', () => {
    const twice = `export function Thing() {\n  return <div className="p-[18px]"><i className="p-[18px]" /></div>;\n}\n`;
    const r = runHook(stdin(`${ROOT}/${FILE}`), deps(twice, OLD_BAD));
    expect(r.code).toBe(2);
  });

  it('a z value already used elsewhere is not new', () => {
    const next = `export function Thing() {\n  return <div className="z-10" />;\n}\n`;
    const r = runHook(
      stdin(`${ROOT}/${FILE}`),
      deps(next, CLEAN_OLD, { usedElsewhere: () => true }),
    );
    expect(r.code).toBe(0);
  });

  it('ignores files outside src/ and tests', () => {
    expect(runHook(stdin(`${ROOT}/scripts/x.ts`), deps(BAD_NEW, '')).code).toBe(0);
    expect(runHook(stdin(`${ROOT}/src/a.test.tsx`), deps(BAD_NEW, '')).code).toBe(0);
    expect(runHook(stdin(`${ROOT}/src/components/dev/A.tsx`), deps(BAD_NEW, '')).code).toBe(0);
  });

  it('ignores bad stdin', () => {
    expect(runHook('not json', deps(BAD_NEW, '')).code).toBe(0);
    expect(runHook('{}', deps(BAD_NEW, '')).code).toBe(0);
  });

  it('reports eslint errors and notes a skipped eslint', () => {
    const withError = runHook(
      stdin(`${ROOT}/${FILE}`),
      deps(CLEAN_NEW, CLEAN_OLD, {
        eslint: () => [
          { line: 2, ruleId: 'no-restricted-syntax', message: 'Use ICON_SIZE.*', severity: 2 },
        ],
      }),
    );
    expect(withError.code).toBe(2);
    expect(withError.stderr.join('\n')).toContain('Use ICON_SIZE.*');

    const warnOnly = runHook(
      stdin(`${ROOT}/${FILE}`),
      deps(CLEAN_NEW, CLEAN_OLD, {
        eslint: () => [{ line: 2, ruleId: 'no-restricted-syntax', message: 'x', severity: 1 }],
      }),
    );
    expect(warnOnly.code).toBe(0);

    const skipped = runHook(
      stdin(`${ROOT}/${FILE}`),
      deps(CLEAN_NEW, CLEAN_OLD, { eslint: () => null }),
    );
    expect(skipped.code).toBe(0);
    expect(skipped.stderr.join('\n')).toContain('eslint skipped');
  });
});
