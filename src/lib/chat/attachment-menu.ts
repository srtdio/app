// The composer's paperclip menu, expressed as data so it stays extensible. PR6
// adds "Share a post" by appending ONE entry to the array returned here, not by
// editing the menu render in AttachmentMenu.tsx. Keeping this SDK-free and pure
// lets the unit job assert the menu is config-driven without a DOM.

import type { ComponentType } from 'react';
import { IconAssets, IconFile, IconPipeline } from '@/components/ui/icons';
import { FILE_ACCEPT, IMAGE_ACCEPT } from '@/lib/chat/attachments';

type IconComponent = ComponentType<{ size?: number; className?: string }>;

/**
 * One menu entry. `accept` is the file-picker filter for picker items; a future
 * non-picker item (PR6's Share a post opens a post picker) leaves it undefined.
 */
export interface AttachmentMenuItem {
  id: string;
  label: string;
  Icon: IconComponent;
  accept?: string;
  onSelect: () => void;
}

export interface AttachmentMenuHandlers {
  onPickPhoto: () => void;
  onPickFile: () => void;
  onSharePost: () => void;
}

/**
 * Build the menu in display order: Photo + File (PR5) plus Share a post (PR6,
 * appended here, not by editing AttachmentMenu's render). "Share a post" is a
 * non-picker item, so it carries no `accept`; it opens the post picker instead.
 * Further items append below; the menu render never changes.
 */
export function attachmentMenuItems(handlers: AttachmentMenuHandlers): AttachmentMenuItem[] {
  return [
    {
      id: 'photo',
      label: 'Photo',
      Icon: IconAssets,
      accept: IMAGE_ACCEPT,
      onSelect: handlers.onPickPhoto,
    },
    {
      id: 'file',
      label: 'File',
      Icon: IconFile,
      accept: FILE_ACCEPT,
      onSelect: handlers.onPickFile,
    },
    {
      id: 'post',
      label: 'Share a post',
      Icon: IconPipeline,
      onSelect: handlers.onSharePost,
    },
  ];
}
