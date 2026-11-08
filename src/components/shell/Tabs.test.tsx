// In-page tabs: role="tablist" of role="tab" buttons with aria-selected (never
// aria-current="page"), one Tab stop, arrows move between tabs.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Tabs, tabKeyTarget } from '@/components/shell/Tabs';
import { CHIP_FACE_SIZE, CHIP_PICKED_EDGE, CHIP_REST_EDGE } from '@/components/ui/Chip';

const ITEMS = [
  { key: 'workspace', label: 'Workspace' },
  { key: 'members', label: 'Members' },
  { key: 'profile', label: 'Profile' },
];

describe('Tabs', () => {
  it('renders a tablist of tabs with aria-selected, never aria-current', () => {
    const html = renderToStaticMarkup(
      <Tabs label="Settings" items={ITEMS} active="members" onChange={() => {}} />,
    );
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Settings"');
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toContain('aria-selected="true"');
    expect(html.match(/aria-selected="false"/g)).toHaveLength(2);
    expect(html).not.toContain('aria-current');
  });

  it('every tab is the shared Chip pill: active = ink line, others rest on border-strong, no fill', () => {
    const html = renderToStaticMarkup(<Tabs items={ITEMS} active="members" onChange={() => {}} />);
    const faces = [...html.matchAll(/<button[^>]*aria-selected="(true|false)"[^>]*><span data-chip-face=""[^>]*class="([^"]*)"/g)];
    expect(faces).toHaveLength(3);
    for (const [, on, cls] of faces) {
      expect(cls).toContain('rounded-full');
      expect(cls).toContain(CHIP_FACE_SIZE);
      expect(cls).toContain(on === 'true' ? CHIP_PICKED_EDGE : CHIP_REST_EDGE);
      for (const c of ['bg-accent', 'text-accent-fg', 'lit-pill', 'bg-panel-3', 'lit-well-soft']) {
        expect(cls).not.toContain(c);
      }
    }
    const active = /<button[^>]*aria-selected="true"[^>]*>/.exec(html)?.[0] ?? '';
    expect(active).toContain('data-selected="true"');
    expect(active).toContain('min-h-11');
    expect(html).not.toContain('h-0.5');
    expect(html).not.toMatch(/[\s"]border-b[\s"]/);
  });

  it('the row scrolls sideways with no scrollbar, like every chip row', () => {
    const html = renderToStaticMarkup(<Tabs items={ITEMS} active="members" onChange={() => {}} />);
    const row = /<div role="tablist"[^>]*>/.exec(html)?.[0] ?? '';
    expect(row).toContain('overflow-x-auto');
    expect(row).toContain('gap-2');
  });

  it('only the active tab is a Tab stop', () => {
    const html = renderToStaticMarkup(<Tabs items={ITEMS} active="members" onChange={() => {}} />);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(2);
  });
});

describe('tabKeyTarget', () => {
  const keys = ITEMS.map((item) => item.key);
  it('Left/Right step and wrap; Home/End jump; other keys do nothing', () => {
    expect(tabKeyTarget(keys, 'workspace', 'ArrowRight')).toBe('members');
    expect(tabKeyTarget(keys, 'profile', 'ArrowRight')).toBe('workspace');
    expect(tabKeyTarget(keys, 'workspace', 'ArrowLeft')).toBe('profile');
    expect(tabKeyTarget(keys, 'members', 'Home')).toBe('workspace');
    expect(tabKeyTarget(keys, 'members', 'End')).toBe('profile');
    expect(tabKeyTarget(keys, 'members', 'Enter')).toBeNull();
  });
});
