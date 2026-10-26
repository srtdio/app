// A generic photo options sheet: Take photo / Choose from library / Remove photo.
// It owns its hidden file inputs (camera and library), so any caller gets a
// working picker from open/onClose/onFile/onRemove alone. The inputs sit outside
// the Sheet so they stay mounted while the sheet runs its exit and the OS picker
// is open; a pick that lands after the sheet closed still reaches onFile.
// Colors are tokens only, so light and dark parity comes from the theme.

import { useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { IconCamera, IconImage, IconTrash, ICON_SIZE } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

type PhotoOption = 'camera' | 'library' | 'remove';

/** Which rows appear, in order. Remove only when a photo is set. Pure. */
export function photoOptions(hasPhoto: boolean): ReadonlyArray<PhotoOption> {
  return hasPhoto ? ['camera', 'library', 'remove'] : ['camera', 'library'];
}

const ROW_LABEL: Record<PhotoOption, string> = {
  camera: 'Take photo',
  library: 'Choose from library',
  remove: 'Remove photo',
};

/**
 * Hand the first picked file (if any) to onFile, then clear the input so picking
 * the same file again still fires a change. Pure apart from the given target.
 */
export function forwardPickedFile(
  target: { files: ArrayLike<File> | null; value: string },
  onFile: (file: File) => void,
): void {
  const file = target.files !== null && target.files.length > 0 ? target.files[0] : undefined;
  target.value = '';
  if (file !== undefined) onFile(file);
}

/** Close the sheet, then run the chosen row's action. */
export function runPhotoOption(
  option: PhotoOption,
  actions: { close: () => void; camera: () => void; library: () => void; remove: () => void },
): void {
  actions.close();
  actions[option]();
}

/** One sheet row: a real button, at least 44px tall; `danger` uses the destructive token. */
function PhotoOptionRow(props: {
  option: PhotoOption;
  icon: ReactNode;
  onSelect: (option: PhotoOption) => void;
}): ReactElement {
  const danger = props.option === 'remove';
  return (
    <button
      type="button"
      data-row={`photo-${props.option}`}
      onClick={() => props.onSelect(props.option)}
      className={cn(
        'flex min-h-[48px] w-full select-none items-center gap-3 rounded-lg px-3 text-left text-base font-medium [-webkit-touch-callout:none]',
        'hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50',
        danger ? 'text-bad' : 'text-fg',
      )}
    >
      <span className={cn('flex w-6 shrink-0 justify-center', danger ? 'text-bad' : 'text-fg-2')}>
        {props.icon}
      </span>
      {ROW_LABEL[props.option]}
    </button>
  );
}

const ROW_ICON: Record<PhotoOption, ReactNode> = {
  camera: <IconCamera size={ICON_SIZE.tray} />,
  library: <IconImage size={ICON_SIZE.tray} />,
  remove: <IconTrash size={ICON_SIZE.tray} />,
};

/** The rows alone (no Sheet, no inputs); the body the sheet renders. */
export function PhotoOptionRows(props: {
  hasPhoto: boolean;
  onSelect: (option: PhotoOption) => void;
}): ReactElement {
  return (
    <div className="flex flex-col pb-[env(safe-area-inset-bottom)]">
      {photoOptions(props.hasPhoto).map((option) => (
        <PhotoOptionRow
          key={option}
          option={option}
          icon={ROW_ICON[option]}
          onSelect={props.onSelect}
        />
      ))}
    </div>
  );
}

export interface PhotoOptionsSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  hasPhoto: boolean;
  onFile: (file: File) => void;
  onRemove: () => void;
}

export function PhotoOptionsSheet(props: PhotoOptionsSheetProps): ReactElement {
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const libraryInputRef = useRef<HTMLInputElement>(null);

  function onSelect(option: PhotoOption): void {
    runPhotoOption(option, {
      close: props.onClose,
      camera: () => cameraInputRef.current?.click(),
      library: () => libraryInputRef.current?.click(),
      remove: props.onRemove,
    });
  }

  function onChange(event: React.ChangeEvent<HTMLInputElement>): void {
    forwardPickedFile(event.target, props.onFile);
  }

  return (
    <>
      <Sheet open={props.open} onClose={props.onClose} title={props.title}>
        <PhotoOptionRows hasPhoto={props.hasPhoto} onSelect={onSelect} />
      </Sheet>
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="user"
        className="hidden"
        onChange={onChange}
      />
      <input
        ref={libraryInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onChange}
      />
    </>
  );
}
