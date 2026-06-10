import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Sheet } from '@/components/ui/Sheet';
import { IconButton } from '@/components/ui/IconButton';
import { IconFile, IconPlus, IconUpload, IconX } from '@/components/ui/icons';
import { fileExtension, humanizeSize } from '@/lib/assets';

/** One queued file with its editable display name and an optional image preview. */
export interface PendingUpload {
  id: string;
  file: File;
  /** The name the user typed; persisted to assets.display_name on commit. */
  name: string;
  /** Object URL for image previews, or null for non-image files. */
  previewUrl: string | null;
}

interface AssetUploadSheetProps {
  open: boolean;
  onClose: () => void;
  /**
   * Commit handler for the queued uploads. When omitted, the sheet stays a
   * naming surface only and the confirm action explains that uploading is not
   * wired yet (no client upload endpoint exists; see the PR notes).
   */
  onSubmit?: (uploads: PendingUpload[]) => void;
}

/** Strip the extension from a filename to seed the editable display name. */
function baseName(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

let pendingSeq = 0;

export function AssetUploadSheet({ open, onClose, onSubmit }: AssetUploadSheetProps) {
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  // Revoke any object URLs we created when the queue changes or the sheet closes,
  // so previews never leak.
  const revokeAll = useCallback((items: PendingUpload[]): void => {
    for (const item of items) {
      if (item.previewUrl !== null) URL.revokeObjectURL(item.previewUrl);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setUploads((prev) => {
        revokeAll(prev);
        return [];
      });
    }
  }, [open, revokeAll]);

  useEffect(() => () => revokeAll(uploads), [uploads, revokeAll]);

  function addFiles(fileList: FileList | null): void {
    if (fileList === null || fileList.length === 0) return;
    const next: PendingUpload[] = Array.from(fileList).map((file) => ({
      id: `pending-${(pendingSeq += 1)}`,
      file,
      name: baseName(file.name),
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
    }));
    setUploads((prev) => [...prev, ...next]);
  }

  function rename(id: string, name: string): void {
    setUploads((prev) => prev.map((item) => (item.id === id ? { ...item, name } : item)));
  }

  function remove(id: string): void {
    setUploads((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target?.previewUrl != null) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((item) => item.id !== id);
    });
  }

  const canCommit = onSubmit !== undefined;
  const hasFiles = uploads.length > 0;

  const footer = (
    <>
      {!canCommit ? (
        <span className="mr-auto text-xs text-fg-3">
          Uploading is not enabled yet. Names are saved when the upload endpoint ships.
        </span>
      ) : null}
      <span className={canCommit ? 'ml-auto flex gap-2.5' : 'flex gap-2.5'}>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!hasFiles || !canCommit}
          onClick={() => {
            if (canCommit) onSubmit(uploads);
          }}
        >
          <IconUpload size={16} />
          {hasFiles ? `Upload ${uploads.length}` : 'Upload'}
        </Button>
      </span>
    </>
  );

  return (
    <Sheet open={open} onClose={onClose} title="Upload assets" footer={footer}>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        multiple
        className="sr-only"
        onChange={(event) => {
          addFiles(event.target.files);
          event.target.value = '';
        }}
      />

      {!hasFiles ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex min-h-[160px] w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong bg-panel-2 px-4 text-center text-fg-2 transition-colors hover:bg-panel-3"
        >
          <IconUpload size={26} />
          <span className="text-sm font-medium">Choose files</span>
          <span className="text-xs text-fg-3">
            Name each file before it is added to the library.
          </span>
        </button>
      ) : (
        <div className="flex flex-col gap-2.5">
          {uploads.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-3 rounded-xl border border-border bg-panel-2 p-2.5"
            >
              <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-panel-3 text-fg-3">
                {item.previewUrl !== null ? (
                  <img src={item.previewUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex flex-col items-center gap-0.5">
                    <IconFile size={20} />
                    {fileExtension(item.file.name) !== '' ? (
                      <span className="text-[10px] font-medium">
                        {fileExtension(item.file.name)}
                      </span>
                    ) : null}
                  </div>
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Input
                  aria-label={`Name for ${item.file.name}`}
                  value={item.name}
                  onChange={(event) => rename(item.id, event.target.value)}
                  className="h-9"
                />
                <span className="truncate text-[11px] text-fg-3">
                  {item.file.name} &middot; {humanizeSize(item.file.size)}
                </span>
              </div>
              <IconButton label={`Remove ${item.file.name}`} onClick={() => remove(item.id)}>
                <IconX size={18} />
              </IconButton>
            </div>
          ))}

          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex h-11 items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-fg-2 transition-colors hover:bg-panel-2"
          >
            <IconPlus size={16} />
            Add more files
          </button>
        </div>
      )}
    </Sheet>
  );
}
