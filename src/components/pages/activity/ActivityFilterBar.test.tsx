import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityFilterBar } from '@/components/pages/activity/ActivityFilterBar';

describe('ActivityFilterBar', () => {
  it('shows exactly All, Unread, Mentions, Briefs, Plans, Snoozed in that order', () => {
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
    expect(labels).toEqual(['All', 'Unread', 'Mentions', 'Briefs', 'Plans', 'Snoozed']);
  });
});
