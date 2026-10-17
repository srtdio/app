// The "This workspace is full" signal. Any upload path that gets the
// asset-upload Worker's 413 workspace_full calls reportWorkspaceFull with the
// file's size; the shell mounts the one sheet that reads it through
// useWorkspaceFullSheet. Module state, so no provider is needed.

import { useCallback, useEffect, useState } from 'react';

let fullFileBytes: number | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): number | null {
  return fullFileBytes;
}

/** Open the full sheet for a file of this size that did not fit. */
export function reportWorkspaceFull(fileSizeBytes: number): void {
  fullFileBytes = fileSizeBytes;
  emit();
}

interface WorkspaceFullSheetState {
  /** The refused file's size while the sheet is open, else null. */
  fileSizeBytes: number | null;
  dismiss: () => void;
}

export function useWorkspaceFullSheet(): WorkspaceFullSheetState {
  const [fileSizeBytes, setFileSizeBytes] = useState(snapshot);
  useEffect(() => {
    setFileSizeBytes(snapshot());
    return subscribe(() => setFileSizeBytes(snapshot()));
  }, []);
  const dismiss = useCallback(() => {
    fullFileBytes = null;
    emit();
  }, []);
  return { fileSizeBytes, dismiss };
}
