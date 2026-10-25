import { describe, expect, it, vi } from 'vitest';
// ActionMenu picks popover vs Sheet by width; the node env has no matchMedia.
vi.mock('@/lib/use-is-laptop', () => ({ useIsLaptop: () => true }));
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityRowMenu, activityRowItems } from '@/components/pages/activity/ActivityRowMenu';

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

  it('is the shared ActionMenu: Mark as read, the snoozes, Un-snooze only when snoozed', () => {
    const base = { onSnooze: () => {}, onMarkRead: () => {} };
    expect(activityRowItems({ ...base, snoozed: false, unread: true }).map((i) => i.label)).toEqual(
      [
        'Mark as read',
        'Snooze 1 hour',
        'Snooze 4 hours',
        'Snooze tomorrow 9 AM',
        'Snooze next week',
      ],
    );
    const read = activityRowItems({ ...base, snoozed: true, unread: false }).map((i) => i.label);
    expect(read).not.toContain('Mark as read');
    expect(read[read.length - 1]).toBe('Un-snooze');
  });
});
