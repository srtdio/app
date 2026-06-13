import { describe, expect, it, vi } from 'vitest';
import { attachmentMenuItems, type AttachmentMenuItem } from '@/lib/chat/attachment-menu';

describe('attachmentMenuItems', () => {
  it('is config-driven: a Photo + File list this PR, in order, each with a picker accept', () => {
    const items = attachmentMenuItems({ onPickPhoto: vi.fn(), onPickFile: vi.fn() });
    expect(items.map((item) => item.id)).toEqual(['photo', 'file']);
    expect(items.map((item) => item.label)).toEqual(['Photo', 'File']);
    for (const item of items) {
      expect(typeof item.accept).toBe('string');
      expect(item.Icon).toBeTypeOf('function');
    }
  });

  it('wires each item to its handler', () => {
    const onPickPhoto = vi.fn();
    const onPickFile = vi.fn();
    const items = attachmentMenuItems({ onPickPhoto, onPickFile });
    items.find((item) => item.id === 'photo')?.onSelect();
    items.find((item) => item.id === 'file')?.onSelect();
    expect(onPickPhoto).toHaveBeenCalledTimes(1);
    expect(onPickFile).toHaveBeenCalledTimes(1);
  });

  it('is append-only extensible so PR6 can add Share a post without a rewrite', () => {
    const items = attachmentMenuItems({ onPickPhoto: vi.fn(), onPickFile: vi.fn() });
    const post: AttachmentMenuItem = {
      id: 'post',
      label: 'Share a post',
      Icon: () => null,
      onSelect: vi.fn(),
    };
    const extended = [...items, post];
    expect(extended.map((item) => item.id)).toEqual(['photo', 'file', 'post']);
  });
});
