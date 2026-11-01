import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { bodyLinkClass, renderMessageBody } from '@/components/chat/message-body';

const read = (f: string): string =>
  readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8');
const ORIGIN = 'https://app.example';
const html = (body: string, mine = false): string =>
  renderToStaticMarkup(<MemoryRouter>{renderMessageBody(body, mine, ORIGIN)}</MemoryRouter>);

describe('message-body (U2: moved out of MessageThread, unchanged)', () => {
  it('external links open in a new tab, shown without the scheme, accent on a peer bubble', () => {
    const out = html('see https://example.com/a?b=1 now');
    expect(out).toContain('href="https://example.com/a?b=1"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('data-msg-link=""');
    expect(out).toContain('>example.com/a?b=1<');
    expect(out).toContain(`class="${bodyLinkClass(false)}"`);
    expect(bodyLinkClass(false)).toBe('underline text-accent');
    expect(bodyLinkClass(true)).toBe('underline text-accent-fg');
  });

  it('app links route in-app; plain text stays a string', () => {
    expect(html(`${ORIGIN}/p/gbl-142`)).not.toContain('target="_blank"');
    expect(renderMessageBody('no links here', false, ORIGIN)).toEqual(['no links here']);
  });

  it('MessageThread renders bodies through this file and keeps its exports; the Plan item screen never imports the thread', () => {
    const thread = read('MessageThread.tsx');
    expect(thread).toMatch(/from '@\/components\/chat\/message-body';/);
    expect(thread).not.toContain('export function renderMessageBody');
    expect(thread).toContain('export { bodyLinkClass, markSearchWords, renderMessageBody };');
    const item = read('PlanItemScreen.tsx');
    expect(item).toContain("import { renderMessageBody } from '@/components/chat/message-body';");
    expect(item).toContain('{renderMessageBody(description, false)}');
    expect(item).not.toMatch(/from '@\/components\/chat\/MessageThread'/);
    expect(item).not.toMatch(/from '@\/components\/chat\/Composer'/);
  });
});
