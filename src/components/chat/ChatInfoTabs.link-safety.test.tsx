import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
import { LinkRow } from '@/components/chat/ChatInfoTabs';

function row(url: string): string {
  return renderToStaticMarkup(
    <LinkRow
      item={{ messageId: 'm1', url, createdAt: '2026-10-01T10:00:00Z', senderUserId: null }}
      sender="Priya"
      date="1 Oct"
    />,
  );
}

describe('Links tab rows', () => {
  it('a safe link stays a new-tab anchor', () => {
    const html = row('https://example.com/a');
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('an unsafe link opens the check sheet, never the site', () => {
    const html = row('http://g00gle-docs-share.top:8080/login');
    expect(html).toContain('data-unsafe-link=""');
    expect(html).not.toContain('href=');
  });
});
