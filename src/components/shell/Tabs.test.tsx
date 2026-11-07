// In-page tabs: role="tablist" of role="tab" buttons with aria-selected (never
// aria-current="page"), one Tab stop, arrows move between tabs.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Tabs, tabKeyTarget } from '@/components/shell/Tabs';

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

  it('the active tab is the ink outline; the others rest on the hairline, no fill, no underline', () => {
    const html = renderToStaticMarkup(<Tabs items={ITEMS} active="members" onChange={() => {}} />);
    const active = /<button[^>]*aria-selected="true"[^>]*>/.exec(html)?.[0] ?? '';
    expect(active).toContain('data-selected="true"');
    expect(active).toContain('border border-fg text-fg');
    for (const c of ['bg-accent', 'text-accent-fg', 'lit-pill']) expect(active).not.toContain(c);
    const idle = [...html.matchAll(/<button[^>]*aria-selected="false"[^>]*>/g)].map((m) => m[0]);
    expect(idle).toHaveLength(2);
    for (const tag of idle) {
      expect(tag).toContain('border border-border text-fg-2');
      expect(tag).not.toContain('bg-panel-3');
      expect(tag).not.toContain('lit-well-soft');
      expect(tag).not.toContain('bg-accent');
    }
    expect(html).not.toContain('h-0.5');
    expect(html).not.toContain('border-b');
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
