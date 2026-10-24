import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const inbox = vi.hoisted(() => ({ unreadCount: 0 }));
// Navigate only acts in an effect (none run in a static render): print what it gets.
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  Navigate: (props: { to: string; replace?: boolean }) => (
    <p>{`navigate ${props.to} replace=${String(props.replace === true)}`}</p>
  ),
}));
vi.mock('@/components/shell/InboxStoreProvider', () => ({
  useInboxStore: () => ({ unreadCount: inbox.unreadCount }),
}));

import {
  NOTIFICATIONS_PATH,
  NotificationsButton,
  notificationsLabel,
  onNotifications,
} from '@/components/shell/NotificationsButton';
import { ActivityRedirect } from '@/components/shell/ActivityRedirect';

function render(path: string, unread = 0): string {
  inbox.unreadCount = unread;
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <NotificationsButton />
    </MemoryRouter>,
  );
}

describe('NotificationsButton', () => {
  it('is a 44x44 button named "Notifications", with the unread count when there is one', () => {
    expect(notificationsLabel(0)).toBe('Notifications');
    expect(notificationsLabel(3)).toBe('Notifications, 3 unread');
    const html = render('/pipeline', 3);
    expect(html).toContain('aria-label="Notifications, 3 unread"');
    expect(html).toContain('h-11 w-11');
    expect(html).toContain('>3</span>');
  });

  it('shows no badge with nothing unread', () => {
    const html = render('/pipeline', 0);
    expect(html).toContain('aria-label="Notifications"');
    expect(html).not.toContain('bg-accent px-1');
  });

  it('tints while the Notifications page is on screen, never elsewhere', () => {
    expect(render(NOTIFICATIONS_PATH)).toContain('bg-accent-soft !text-accent');
    expect(render(NOTIFICATIONS_PATH)).toContain('aria-current="page"');
    expect(render('/chat')).not.toContain('bg-accent-soft');
    expect(onNotifications('/notifications')).toBe(true);
    expect(onNotifications('/notificationsx')).toBe(false);
    expect(onNotifications('/plans/x')).toBe(false);
  });
});

describe('/activity', () => {
  it('redirects to /notifications in place, keeping the query string', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/activity?x=1&y=2']}>
        <Routes>
          <Route path="/activity" element={<ActivityRedirect />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(html).toContain('navigate /notifications?x=1&amp;y=2 replace=true');
  });
});
