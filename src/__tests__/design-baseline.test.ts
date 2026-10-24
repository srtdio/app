import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The design rules baseline (files exempt from the design lint) was emptied
// by the Shapes PR and removed: every file passes the design rules now.
const CONFIG = readFileSync(
  fileURLToPath(new URL('../../eslint.config.js', import.meta.url)),
  'utf8',
);

describe('design rules baseline', () => {
  it('eslint.config.js has no designRulesBaseline', () => {
    expect(CONFIG).not.toContain('designRulesBaseline');
  });

  it('the design rules also ban a "!" override on a ui primitive and rgba() in a className', () => {
    expect(CONFIG).toContain('Button|IconButton|Chip|PressableRow|Backdrop|DropZone');
    expect(CONFIG).toMatch(/RGBA_CLASS = '\/rgba/);
  });
});
