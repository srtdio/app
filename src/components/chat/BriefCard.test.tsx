import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { BriefCardItem } from '@/components/chat/BriefCard';

function render(status: string): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <BriefCardItem view={{ kind: 'brief', briefId: 'b1', title: 'Diwali reel', status }} />
    </MemoryRouter>,
  );
}

// The chat brief card wears the same pill as the Briefs list and detail, so
// Open and Closed read clearly apart in a thread.
describe('chat brief card status pill', () => {
  it('Open: accent-soft pill with an accent dot', () => {
    const out = render('open');
    expect(out).toContain('data-brief-status="open"');
    expect(out).toContain('bg-accent-soft text-accent');
    expect(out).toContain('rounded-full bg-accent');
    expect(out).toContain('Open');
    expect(out).not.toContain('Closed');
  });

  it('Closed: panel-3 pill with a lock icon', () => {
    const out = render('closed');
    expect(out).toContain('data-brief-status="closed"');
    expect(out).toContain('bg-panel-3 text-fg-2');
    expect(out).not.toContain('bg-accent-soft');
    expect(out).toContain('<rect');
    expect(out).toContain('Closed');
  });

  it('Open and Closed render different markup', () => {
    expect(render('open')).not.toBe(render('closed'));
  });
});
