import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import {
  attachmentItemList,
  attachmentVersionIds,
  removeAttachmentAt,
  runFileAttachment,
  runLinkAttachment,
  type AttachmentItem,
} from '@/components/pages/create/AttachmentsField';

const items: AttachmentItem[] = [
  { versionId: 'v1', kind: 'image', name: 'a.png' },
  { versionId: 'v2', kind: 'file', name: 'b.pdf' },
  { versionId: 'v3', kind: 'link', name: 'Site' },
];

function lastChild(el: ReactElement): ReactElement {
  const children = (el.props as { children: ReactElement | ReactElement[] }).children;
  return Array.isArray(children) ? (children[children.length - 1] as ReactElement) : children;
}

describe('attachment list helpers', () => {
  it('returns the version ids in order', () => {
    expect(attachmentVersionIds(items)).toEqual(['v1', 'v2', 'v3']);
  });

  it('removes by index, preserving the order of the rest', () => {
    expect(attachmentVersionIds(removeAttachmentAt(items, 1))).toEqual(['v1', 'v3']);
  });

  it('renders one element per item, in order, each with a remove control', () => {
    const onRemove = vi.fn();
    const els = attachmentItemList(items, onRemove);
    expect(els).toHaveLength(3);
    const removeFile = lastChild(els[1] as ReactElement);
    (removeFile.props as { onClick: () => void }).onClick();
    expect(onRemove).toHaveBeenCalledWith(1);
  });
});

describe('runFileAttachment', () => {
  it('uploads a photo and resolves a versionId with an image kind', async () => {
    const file = new File(['x'], 'photo.png', { type: 'image/png' });
    const uploadFile = vi.fn(
      async () => ({ ok: true, reused: false, versionId: 'ver-1' }) as const,
    );
    const result = await runFileAttachment(file, true, uploadFile);
    expect(result).toEqual({
      ok: true,
      item: { versionId: 'ver-1', kind: 'image', name: 'photo.png' },
    });
  });

  it('uploads a document and resolves a versionId with a file kind', async () => {
    const file = new File(['x'], 'doc.pdf', { type: 'application/pdf' });
    const uploadFile = vi.fn(
      async () => ({ ok: true, reused: false, versionId: 'ver-2' }) as const,
    );
    const result = await runFileAttachment(file, false, uploadFile);
    expect(result).toEqual({
      ok: true,
      item: { versionId: 'ver-2', kind: 'file', name: 'doc.pdf' },
    });
  });

  it('surfaces the upload failure message', async () => {
    const file = new File(['x'], 'doc.pdf', { type: 'application/pdf' });
    const uploadFile = vi.fn(async () => ({ ok: false, message: 'nope' }) as const);
    const result = await runFileAttachment(file, false, uploadFile);
    expect(result).toEqual({ ok: false, message: 'nope' });
  });
});

describe('runLinkAttachment', () => {
  it('adds a link then resolves its current version id', async () => {
    const addLink = vi.fn(async () => ({ ok: true, assetId: 'asset-9' }) as const);
    const resolveVersionId = vi.fn(async () => 'ver-link');
    const result = await runLinkAttachment({
      url: 'https://example.com',
      name: 'Example',
      addLink,
      resolveVersionId,
    });
    expect(addLink).toHaveBeenCalledWith('https://example.com', 'Example');
    expect(resolveVersionId).toHaveBeenCalledWith('asset-9');
    expect(result).toEqual({
      ok: true,
      item: { versionId: 'ver-link', kind: 'link', name: 'Example' },
    });
  });

  it('rejects an invalid url before any request', async () => {
    const addLink = vi.fn();
    const result = await runLinkAttachment({
      url: 'ftp://nope',
      name: 'X',
      addLink,
      resolveVersionId: vi.fn(),
    });
    expect(addLink).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it('fails when the version id cannot be resolved', async () => {
    const addLink = vi.fn(async () => ({ ok: true, assetId: 'asset-9' }) as const);
    const resolveVersionId = vi.fn(async () => null);
    const result = await runLinkAttachment({
      url: 'https://example.com',
      name: 'Example',
      addLink,
      resolveVersionId,
    });
    expect(result.ok).toBe(false);
  });
});
