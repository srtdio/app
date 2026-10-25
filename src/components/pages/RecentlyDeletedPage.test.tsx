import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RecentlyDeletedView } from '@/components/pages/RecentlyDeletedPage';
import type { DeletedAssetItem } from '@/lib/assets';

// The page body is hook-free, so it is rendered to static markup here (this
// node test environment has no DOM); the network paths are covered by the
// purge/restore client tests in src/lib.

const NOW = Date.parse('2026-10-17T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const items: DeletedAssetItem[] = [
  {
    id: 'a1',
    name: 'A very long campaign file name that must wrap and never truncate.png',
    deletedAt: new Date(NOW - 2 * DAY).toISOString(),
    sizeBytes: 3 * 1024 * 1024,
  },
  {
    id: 'a2',
    name: 'notes.pdf',
    deletedAt: new Date(NOW - 30 * DAY).toISOString(),
    sizeBytes: 1024 * 1024,
  },
];

function render(isOwner: boolean, list = items): string {
  return renderToStaticMarkup(
    <RecentlyDeletedView
      items={list}
      now={NOW}
      isOwner={isOwner}
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

describe('RecentlyDeletedView', () => {
  it('shows the hint and two-line rows with size and days left', () => {
    const out = render(false);
    expect(out).toContain(
      'Files stay here 31 days, then are deleted for good. They still count toward storage until then.',
    );
    expect(out).toContain(items[0]!.name);
    expect(out).toContain('3 MB · gone in 29 days');
    expect(out).toContain('1 MB · gone in 1 day');
    expect(out).not.toMatch(/class="[^"]*\btruncate\b/);
  });

  it('gives members Restore only, plus the owner note', () => {
    const out = render(false);
    expect(out).toContain('Restore');
    expect(out).not.toContain('Delete now');
    expect(out).not.toContain('Empty now');
    expect(out).toContain('Only the workspace owner can delete files early.');
  });

  it('gives the owner Delete now in the bad token and Empty now with the freed size', () => {
    const out = render(true);
    expect(out).toContain('Delete now');
    expect(out).toContain('text-bad');
    expect(out).toContain('Empty now');
    expect(out).toContain('Frees 4 MB right away.');
    expect(out).not.toContain('Only the workspace owner');
  });

  it('keeps every action at 44px', () => {
    const out = render(true);
    expect(out.match(/h-11/g)?.length).toBe(items.length * 2 + 1);
  });

  it('shows only the load failure line and a 44px Retry when the read fails', () => {
    const out = renderToStaticMarkup(
      <RecentlyDeletedView
        items={[]}
        now={NOW}
        isOwner
        loading={false}
        failed
        busyId={null}
        onRetry={() => {}}
        onRestore={() => {}}
        onDeleteNow={() => {}}
        onEmpty={() => {}}
      />,
    );
    expect(out).toMatch(/role="alert"[^>]*>Couldn&#x27;t load deleted files\. Try again\.<\/div>/);
    expect(out).toContain('Retry');
    expect(out).toContain('h-11');
  });

  it('shows only the hint when nothing is here', () => {
    const out = render(true, []);
    expect(out).not.toContain('Empty now');
    expect(out).not.toContain('Restore');
  });
});
