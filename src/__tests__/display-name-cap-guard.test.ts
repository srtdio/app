import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Display-name cap (users.display_name CHECK char_length <= 25, constraint
// users_display_name_max25). Every input that writes users.display_name takes
// maxLength={DISPLAY_NAME_MAX}, shows the live counter (ui/Input `counter` fed
// by nameCounter, meta role, from 20 characters) and maps the server's refusal
// to NAME_TOO_LONG. Shared logic: src/lib/display-name.ts.
const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** The display-name inputs: file, the input's id. */
const NAME_INPUTS: { file: string; id: string }[] = [
  // Onboarding name step (sign up and invite accept both land here).
  { file: 'components/onboarding/OnboardingFlow.tsx', id: 'ob-name' },
  // Settings > Profile.
  { file: 'components/settings/ProfileSettingsPanel.tsx', id: 'settings-display-name' },
];

function read(rel: string): string {
  return readFileSync(`${ROOT}${rel}`, 'utf8');
}

/** The JSX of the <Input> whose id is `id`, up to its closing "/>". */
function inputBlock(src: string, id: string): string {
  const at = src.indexOf(`id="${id}"`);
  if (at < 0) return '';
  const start = src.lastIndexOf('<Input', at);
  const end = src.indexOf('/>', at);
  return start < 0 || end < 0 ? '' : src.slice(start, end);
}

describe('display-name inputs are capped at 25', () => {
  for (const { file, id } of NAME_INPUTS) {
    describe(file, () => {
      const src = read(file);
      const block = inputBlock(src, id);

      it('has the name input', () => {
        expect(block).not.toBe('');
      });

      it('caps it with maxLength={DISPLAY_NAME_MAX}', () => {
        expect(block).toContain('maxLength={DISPLAY_NAME_MAX}');
        expect(block).not.toMatch(/maxLength=\{\d+\}/);
      });

      it('shows the live counter through ui/Input counter + nameCounter', () => {
        expect(block).toMatch(/counter=\{nameCounter\(/);
      });

      it('maps the server refusal to NAME_TOO_LONG', () => {
        expect(src).toContain("from '@/lib/display-name'");
        expect(src).toContain('isNameTooLong(');
        expect(src).toContain('NAME_TOO_LONG');
      });
    });
  }

  it('the counter renders in the meta role inside ui/Input (one part, no hand-built frame)', () => {
    const input = read('components/ui/Input.tsx');
    expect(input).toContain('role="meta"');
    expect(input).toContain('aria-live="polite"');
    expect(input).toContain('counter?: string | null');
  });

  it('the shared copy has no em-dash', () => {
    expect(read('lib/display-name.ts')).not.toContain('—');
  });
});
