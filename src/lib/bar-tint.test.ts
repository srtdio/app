import { describe, expect, it } from 'vitest';
import { barTintFor } from '@/lib/bar-tint';

// The browser bar takes the colour of the solid surface at the top of each
// screen: the Topbar (panel) almost everywhere, a phone chat thread's header
// (panel), and the canvas (bg) on a phone Post or Brief detail page.

const phone = (pathname: string, search = '', threadOpen = false) =>
  barTintFor({ pathname, search, isLaptop: false, threadOpen });
const laptop = (pathname: string, search = '', threadOpen = false) =>
  barTintFor({ pathname, search, isLaptop: true, threadOpen });

describe('barTintFor', () => {
  it('Topbar screens on a phone are panel', () => {
    for (const path of [
      '/pipeline',
      '/briefs',
      '/assets',
      '/plan',
      '/activity',
      '/settings',
      '/chat',
    ])
      expect(phone(path)).toBe('panel');
  });

  it('a phone chat thread is panel (its header), by flag or by URL', () => {
    expect(phone('/chat', '?channel=abc', true)).toBe('panel');
    expect(phone('/chat', '?channel=abc')).toBe('panel');
    expect(phone('/chat', new URLSearchParams('channel=abc'))).toBe('panel');
    expect(phone('/chat/new')).toBe('panel');
    expect(phone('/chat', '?channel=')).toBe('panel');
  });

  it('phone Post and Brief detail pages are bg (no Topbar, unfilled header)', () => {
    for (const path of ['/posts/123', '/p/abc', '/briefs/9', '/b/xyz', '/posts/123/'])
      expect(phone(path)).toBe('bg');
  });

  it('lists and nested routes under posts and briefs are not detail pages', () => {
    expect(phone('/posts')).toBe('panel');
    expect(phone('/briefs')).toBe('panel');
    expect(phone('/posts/1/edit')).toBe('panel');
  });

  it('laptop (and touch tablet) is always panel: the Topbar is on every screen', () => {
    for (const path of ['/pipeline', '/posts/1', '/b/x', '/chat', '/activity'])
      expect(laptop(path)).toBe('panel');
    expect(laptop('/chat', '?channel=a', true)).toBe('panel');
  });

  it('returns a token name, never a colour value', () => {
    for (const t of [phone('/pipeline'), phone('/posts/1'), laptop('/x')])
      expect(['panel', 'bg']).toContain(t);
  });
});
