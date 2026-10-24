import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityRowMenu } from '@/components/pages/activity/ActivityRowMenu';

// Button system regression: the row's options trigger is the shared IconButton.

describe('ActivityRowMenu buttons', () => {
  it('renders the trigger at 44x44 with the 8px radius', () => {
    const html = renderToStaticMarkup(
      <ActivityRowMenu snoozed={false} unread onSnooze={() => {}} onMarkRead={() => {}} />,
    );
    const tag = (html.match(/<button\b[^>]*>/) ?? [''])[0];
    expect(tag).toContain('aria-label="Activity options"');
    expect(tag).toContain('h-11 w-11');
    expect(tag).toContain('rounded-lg');
    expect(tag).not.toMatch(/\b(rounded-md|h-9|h-12)\b/);
  });
});
