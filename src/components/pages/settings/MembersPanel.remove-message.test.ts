// Remove member: the ConfirmDialog message puts one consequence per line
// (joined with a newline, rendered by ConfirmDialog's whitespace-pre-line),
// never one run-on line split by bullets. Same four sentences.
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('./MembersPanel.tsx', import.meta.url)), 'utf8');
const dialog = readFileSync(
  fileURLToPath(new URL('../../ui/ConfirmDialog.tsx', import.meta.url)),
  'utf8',
);

describe('MembersPanel remove member message', () => {
  it('joins the four consequences with a newline, not a bullet', () => {
    expect(source).toContain(`].join('\\n')}`);
    expect(source).not.toContain(`join(' • ')`);
    for (const line of [
      'the moment you confirm.',
      'Signed out everywhere. Chat access ends immediately.',
      'Their posts, comments and uploads stay, shown as',
      'You can invite them back any time.',
    ]) {
      expect(source).toContain(line);
    }
  });

  it('ConfirmDialog renders the message with whitespace-pre-line', () => {
    expect(dialog).toMatch(/data-confirm-message=""[^>]*whitespace-pre-line/);
  });
});
