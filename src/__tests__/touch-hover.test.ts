import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../../tailwind.config';

// Guards the touch-screen fixes: no sticky hover after a tap, no tap flash.
describe('touch: no tap flash or sticky hover', () => {
  it('tailwind applies hover: only where hover is supported', () => {
    expect(config.future?.hoverOnlyWhenSupported).toBe(true);
  });

  it('index.css sets the tap highlight transparent on html', () => {
    const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8');
    expect(css).toMatch(/html\s*\{[^}]*-webkit-tap-highlight-color:\s*transparent;/);
  });
});
