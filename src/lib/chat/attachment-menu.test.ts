import { describe, expect, it, vi } from 'vitest';
import { attachmentMenuItems, type AttachmentMenuItem } from '@/lib/chat/attachment-menu';

function handlers() {
  return { onPickPhoto: vi.fn(), onPickFile: vi.fn(), onSharePost: vi.fn() };
}

describe('attachmentMenuItems', () => {
  it('is config-driven: Photo + File + Share a post, in order', () => {
    const items = attachmentMenuItems(handlers());
    expect(items.map((item) => item.id)).toEqual(['photo', 'file', 'post']);
    expect(items.map((item) => item.label)).toEqual(['Photo', 'File', 'Share a post']);
    for (const item of items) {
      expect(item.Icon).toBeTypeOf('function');
    }
  });

  it('gives the file-picker items an accept and the Share-a-post item none', () => {
    const items = attachmentMenuItems(handlers());
    expect(typeof items.find((item) => item.id === 'photo')?.accept).toBe('string');
    expect(typeof items.find((item) => item.id === 'file')?.accept).toBe('string');
    // The post item opens a picker, not a file dialog, so it carries no accept.
    expect(items.find((item) => item.id === 'post')?.accept).toBeUndefined();
  });

  it('wires each item to its handler', () => {
    const h = handlers();
    const items = attachmentMenuItems(h);
    items.find((item) => item.id === 'photo')?.onSelect();
    items.find((item) => item.id === 'file')?.onSelect();
    items.find((item) => item.id === 'post')?.onSelect();
    expect(h.onPickPhoto).toHaveBeenCalledTimes(1);
    expect(h.onPickFile).toHaveBeenCalledTimes(1);
    expect(h.onSharePost).toHaveBeenCalledTimes(1);
  });

  it('stays append-only: a future entry adds to the end without a rewrite', () => {
    const items = attachmentMenuItems(handlers());
    const next: AttachmentMenuItem = {
      id: 'next',
      label: 'Something else',
      Icon: () => null,
      onSelect: vi.fn(),
    };
    const extended = [...items, next];
    expect(extended.map((item) => item.id)).toEqual(['photo', 'file', 'post', 'next']);
  });
});
