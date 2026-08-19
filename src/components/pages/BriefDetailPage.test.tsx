import { describe, expect, it } from 'vitest';
import {
  briefAuthorLabel,
  briefExternalLinks,
  briefMediaItems,
} from '@/components/pages/BriefDetailPage';
import type { BriefGalleryItem } from '@srtdio/briefs';

// Unit-test the pure "Created by" resolver across every branch. The resolver is
// handed a memberName lookup that returns a current member's display name or null
// when the id is not a current member, mirroring the page's memberById map.
describe('briefAuthorLabel', () => {
  const members: Record<string, string> = { u1: 'Asha Rao' };
  const memberName = (id: string): string | null => members[id] ?? null;

  it('resolves created_by to the member name, taking precedence over a legacy name', () => {
    expect(briefAuthorLabel('u1', 'Old Name', memberName)).toBe('Asha Rao');
  });

  it('falls back to the legacy name when created_by does not resolve to a member', () => {
    expect(briefAuthorLabel('u404', 'Old Name', memberName)).toBe('Old Name');
  });

  it('returns the legacy name when created_by is null', () => {
    expect(briefAuthorLabel(null, 'Old Name', memberName)).toBe('Old Name');
  });

  it('returns (ex-member) when created_by is unresolved and there is no legacy name', () => {
    expect(briefAuthorLabel('u404', null, memberName)).toBe('(ex-member)');
  });

  it('returns (ex-member) when created_by is null and there is no legacy name', () => {
    expect(briefAuthorLabel(null, null, memberName)).toBe('(ex-member)');
  });

  it('treats an empty created_by string as no member and falls back', () => {
    expect(briefAuthorLabel('', 'Old Name', memberName)).toBe('Old Name');
  });
});

// The link merge and the gallery split. A link-kind attachment used to reach
// PostGallery, which has no link branch and painted it as a dead tile; it is now
// filtered out of the gallery and folded into the links list instead.
function item(partial: Partial<BriefGalleryItem> & { kind: string }): BriefGalleryItem {
  return {
    assetAttachmentId: `att-${partial.kind}`,
    assetVersionId: 'av1',
    assetId: 'a1',
    position: 0,
    filename: 'file.png',
    mimeType: 'image/png',
    width: null,
    height: null,
    durationMs: null,
    r2Key: 'key/one.png',
    externalUrl: null,
    ...partial,
  };
}

describe('briefMediaItems', () => {
  it('drops link-kind attachments and keeps every media kind in order', () => {
    const gallery = [
      item({ kind: 'image', assetAttachmentId: 'a' }),
      item({ kind: 'link', assetAttachmentId: 'b', externalUrl: 'https://drive.google.com/x' }),
      item({ kind: 'video', assetAttachmentId: 'c' }),
    ];
    expect(briefMediaItems(gallery).map((i) => i.assetAttachmentId)).toEqual(['a', 'c']);
  });

  it('returns an empty list for a gallery of links only', () => {
    expect(briefMediaItems([item({ kind: 'link', externalUrl: 'https://a.example' })])).toEqual([]);
  });
});

describe('briefExternalLinks', () => {
  it('puts reference_links first, then link attachments', () => {
    const links = briefExternalLinks(
      ['https://ref.example/a'],
      [item({ kind: 'image' }), item({ kind: 'link', externalUrl: 'https://attach.example/b' })],
    );
    expect(links).toEqual([
      { href: 'https://ref.example/a', domain: 'ref.example' },
      { href: 'https://attach.example/b', domain: 'attach.example' },
    ]);
  });

  it('dedupes across both sources by href', () => {
    const links = briefExternalLinks({ drive_link: 'https://drive.google.com/x' }, [
      item({ kind: 'link', externalUrl: 'https://drive.google.com/x' }),
    ]);
    expect(links).toEqual([{ href: 'https://drive.google.com/x', domain: 'drive.google.com' }]);
  });

  it('drops unusable entries from either source', () => {
    const links = briefExternalLinks(
      ['not-a-url', 'javascript:alert(1)'],
      [
        item({ kind: 'link', externalUrl: null }),
        item({ kind: 'link', externalUrl: 'https://ok.example/c' }),
      ],
    );
    expect(links).toEqual([{ href: 'https://ok.example/c', domain: 'ok.example' }]);
  });

  it('is empty when the brief has neither reference links nor link attachments', () => {
    expect(briefExternalLinks(null, [item({ kind: 'image' })])).toEqual([]);
    expect(briefExternalLinks(null, [])).toEqual([]);
  });
});
