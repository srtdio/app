import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FIELD_DISABLED, Input } from '@/components/ui/Input';
import { WRITING_FIELD_DISABLED } from '@/components/ui/WritingBox';

const read = (file: string): string =>
  readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');

// One switched-off look for every field (11 Nov 2026): the ink line drops to
// the grey edge, text and placeholder go fg-3. Never a fade.
describe('switched-off fields', () => {
  it('the one field look', () => {
    expect(FIELD_DISABLED.split(' ')).toEqual(
      expect.arrayContaining([
        'disabled:border-border-strong',
        'disabled:text-fg-3',
        'disabled:placeholder:text-fg-3',
      ]),
    );
    expect(FIELD_DISABLED).not.toMatch(/opacity/);
  });

  it('Input renders it', () => {
    const html = renderToStaticMarkup(<Input aria-label="Name" disabled />);
    expect(html).toContain('disabled:border-border-strong');
    expect(html).toContain('disabled:text-fg-3');
  });

  it('Textarea, Select and WritingBox (field shape) take the grey edge too', () => {
    expect(read('./Textarea.tsx')).toContain('FIELD_DISABLED,');
    const select = read('./Select.tsx');
    expect(select).toContain('disabled:border-border-strong disabled:text-fg-3');
    expect(WRITING_FIELD_DISABLED).toBe('has-[textarea:disabled]:border-border-strong');
    expect(read('./WritingBox.tsx')).toContain('WRITING_FIELD_DISABLED,');
  });
});
