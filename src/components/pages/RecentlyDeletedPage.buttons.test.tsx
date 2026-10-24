import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RecentlyDeletedView } from '@/components/pages/RecentlyDeletedPage';

// Button system regression: Restore, Delete now and Empty now share one recipe.

const NOW = Date.parse('2026-10-17T12:00:00Z');

function render(): string {
  return renderToStaticMarkup(
    <RecentlyDeletedView
      items={[
        { id: 'a1', name: 'photo.png', deletedAt: new Date(NOW).toISOString(), sizeBytes: 1024 },
      ]}
      now={NOW}
      isOwner
      loading={false}
      failed={false}
      busyId={null}
      onRetry={() => {}}
      onRestore={() => {}}
      onDeleteNow={() => {}}
      onEmpty={() => {}}
    />,
  );
}

describe('RecentlyDeletedView buttons', () => {
  it('renders every action at 44px with the 8px radius', () => {
    const tags = render().match(/<button\b[^>]*>/g) ?? [];
    expect(tags.length).toBe(3);
    for (const tag of tags) {
      expect(tag).toContain('h-11');
      expect(tag).toContain('rounded-lg');
      expect(tag).not.toMatch(/\b(h-9|h-12|rounded-md|font-semibold)\b/);
    }
  });

  it('keeps Delete now in the bad token', () => {
    const tag = (render().match(/<button\b[^>]*>Delete now/) ?? [''])[0];
    expect(tag).toContain('text-bad');
  });
});
