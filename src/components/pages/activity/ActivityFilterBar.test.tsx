import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityFilterBar, moreToRight } from '@/components/pages/activity/ActivityFilterBar';

describe('ActivityFilterBar', () => {
  it('shows exactly All, Unread, Mentions, Briefs, Plans, Upcoming, Snoozed in that order', () => {
    const html = renderToStaticMarkup(
      <ActivityFilterBar
        state="all"
        onStateChange={() => undefined}
        totalUnread={0}
        mentionCount={0}
      />,
    );
    const labels = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) =>
      (m[1] ?? '').replace(/<[^>]+>/g, '').trim(),
    );
    expect(labels).toEqual(['All', 'Unread', 'Mentions', 'Briefs', 'Plans', 'Upcoming', 'Snoozed']);
  });

  it('never folds a count into the Upcoming chip', () => {
    const html = renderToStaticMarkup(
      <ActivityFilterBar
        state="upcoming"
        onStateChange={() => undefined}
        totalUnread={4}
        mentionCount={2}
      />,
    );
    const labels = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) =>
      (m[1] ?? '').replace(/<[^>]+>/g, '').trim(),
    );
    expect(labels).toContain('Upcoming');
    expect(labels.filter((l) => l.startsWith('Upcoming'))).toEqual(['Upcoming']);
  });

  it('fix 3: fades only while chips remain to the right (2px slack)', () => {
    expect(moreToRight({ scrollLeft: 0, clientWidth: 390, scrollWidth: 600 })).toBe(true);
    expect(moreToRight({ scrollLeft: 207, clientWidth: 390, scrollWidth: 600 })).toBe(true);
    expect(moreToRight({ scrollLeft: 208, clientWidth: 390, scrollWidth: 600 })).toBe(false);
    expect(moreToRight({ scrollLeft: 210, clientWidth: 390, scrollWidth: 600 })).toBe(false);
    expect(moreToRight({ scrollLeft: 0, clientWidth: 390, scrollWidth: 390 })).toBe(false);
  });

  it('fix 3: no negative right margin; a trailing spacer ends the row; no fade before measuring', () => {
    const html = renderToStaticMarkup(
      <ActivityFilterBar
        state="all"
        onStateChange={() => undefined}
        totalUnread={0}
        mentionCount={0}
      />,
    );
    const row = /<div data-activity-chips=""[^>]*class="([^"]*)"[^>]*style="([^"]*)"/.exec(html);
    expect(row).not.toBeNull();
    expect(row?.[1]).not.toMatch(/-mr-/);
    expect(row?.[2]).not.toContain('padding-right:0');
    expect(row?.[2]).toContain('mask-image:none');
    expect(html).toMatch(
      /<span aria-hidden="true" data-activity-chips-end=""[^>]*><\/span><\/div>$/,
    );
  });
});
