// Where a post's new file comes from (18 Nov 2026): the one sheet behind Add
// (tools row, the empty state) and Replace (the opened picture). Three rows:
// a photo or video from the device, a document from the device, or a file
// already in Assets. It is presentational only: it reports the pick and
// closes; the page runs its existing upload or attach flow and the single
// gallery write.

import type { ReactNode } from 'react';
import { trayIcon } from '@/components/ui/ActionRow';
import { PressableRow } from '@/components/ui/PressableRow';
import { Sheet } from '@/components/ui/Sheet';
import { IconAssets, IconFile, IconPhoto } from '@/components/ui/icons';
import { textRole } from '@/components/ui/Text';
import { ALLOWED_MIME_TYPES, isImageMime } from '@srtdio/storage';

export type AddSource = 'media' | 'document' | 'assets';

export const ADD_SOURCE_TITLE = 'Add to this post';
export const ADD_SOURCE_REPLACE_NOTE = 'The new file takes its place. The order stays.';

/** The sheet's title: Add, or Replace with the picture's place. Pure. */
export function addSourceTitle(replaceIndex: number | null): string {
  return replaceIndex === null ? ADD_SOURCE_TITLE : `Replace picture ${replaceIndex + 1}`;
}

export const ADD_SOURCE_ROWS: readonly { source: AddSource; label: string; hint: string }[] = [
  { source: 'media', label: 'Photo or video', hint: 'From this device' },
  { source: 'document', label: 'Document', hint: 'PDF, Word, slides, sheets' },
  { source: 'assets', label: 'Assets', hint: 'Already in Sorted' },
];

const isMedia = (mime: string): boolean => isImageMime(mime) || mime.startsWith('video/');

/** The file chooser's filter per device source: pictures and videos, or documents. */
export const ADD_SOURCE_ACCEPT: Record<Exclude<AddSource, 'assets'>, string> = {
  media: ALLOWED_MIME_TYPES.filter(isMedia).join(','),
  document: ALLOWED_MIME_TYPES.filter((mime) => !isMedia(mime) && !mime.startsWith('audio/')).join(
    ',',
  ),
};

const ROW_ICON: Record<AddSource, ReactNode> = {
  media: <IconPhoto />,
  document: <IconFile />,
  assets: <IconAssets />,
};

interface AddSourceSheetProps {
  open: boolean;
  onClose: () => void;
  /** The place of the picture being replaced; null when adding. */
  replaceIndex: number | null;
  onPick: (source: AddSource) => void;
}

export function AddSourceSheet({ open, onClose, replaceIndex, onPick }: AddSourceSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title={addSourceTitle(replaceIndex)}>
      <div data-add-source="" className="flex flex-col gap-1">
        {replaceIndex !== null ? (
          <p data-add-source-note="" className={textRole('body', 'px-3 pb-2 text-fg-2')}>
            {ADD_SOURCE_REPLACE_NOTE}
          </p>
        ) : null}
        {ADD_SOURCE_ROWS.map((row) => (
          <PressableRow
            key={row.source}
            type="button"
            data-add-source-row={row.source}
            onClick={() => onPick(row.source)}
            className="flex items-center gap-3 px-3 py-2 mv-tint"
          >
            <span className="flex shrink-0 items-center justify-center text-fg-2">
              {trayIcon(ROW_ICON[row.source])}
            </span>
            <span className={textRole('body', 'min-w-0 flex-1 truncate font-medium text-fg')}>
              {row.label}
            </span>
            <span className={textRole('secondary', 'shrink-0 text-fg-3')}>{row.hint}</span>
          </PressableRow>
        ))}
      </div>
    </Sheet>
  );
}
