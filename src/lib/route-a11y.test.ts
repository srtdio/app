// @vitest-environment jsdom
// Route changes: "{Screen} · Sorted" titles (the unread prefix kept) and the
// h1 that takes focus on navigation.
import { afterEach, describe, expect, it } from 'vitest';
import { routeHeading, routeTitle, screenNameFor } from '@/lib/route-a11y';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('screenNameFor', () => {
  it('names every shell screen', () => {
    expect(screenNameFor('/pipeline')).toBe('Pipeline');
    expect(screenNameFor('/posts/abc')).toBe('Post');
    expect(screenNameFor('/p/ACME-1')).toBe('Post');
    expect(screenNameFor('/briefs')).toBe('Briefs');
    expect(screenNameFor('/briefs/abc')).toBe('Brief');
    expect(screenNameFor('/b/ACME-2')).toBe('Brief');
    expect(screenNameFor('/chat')).toBe('Chat');
    expect(screenNameFor('/notifications')).toBe('Activity');
    expect(screenNameFor('/plan')).toBe('Plan');
    expect(screenNameFor('/plans/x')).toBe('Plan');
    expect(screenNameFor('/assets')).toBe('Assets');
    expect(screenNameFor('/settings')).toBe('Settings');
    expect(screenNameFor('/help')).toBe('Help');
    expect(screenNameFor('/deleted')).toBe('Recently deleted');
    expect(screenNameFor('/elsewhere')).toBeNull();
  });
});

describe('routeTitle', () => {
  it('is "{Screen} · Sorted", keeping the chat unread prefix', () => {
    expect(routeTitle('Pipeline', 'Sorted')).toBe('Pipeline · Sorted');
    expect(routeTitle('Chat', '(3) Pipeline · Sorted')).toBe('(3) Chat · Sorted');
    expect(routeTitle(null, 'x')).toBe('Sorted');
  });
});

describe('routeHeading', () => {
  it('finds the page h1 (tabIndex -1) in main, never one inside a dialog', () => {
    document.body.innerHTML =
      '<div role="dialog"><main><h1 tabindex="-1">Sheet</h1></main></div>' +
      '<main><h1>Plain</h1><h1 tabindex="-1">Pipeline</h1></main>';
    expect(routeHeading()?.textContent).toBe('Pipeline');
  });

  it('is null with no focusable h1', () => {
    document.body.innerHTML = '<main><h1>Plain</h1></main>';
    expect(routeHeading()).toBeNull();
  });
});
