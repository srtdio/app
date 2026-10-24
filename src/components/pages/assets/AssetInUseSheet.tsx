import { useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { openParentLabel, type AssetParent } from '@/lib/assets';

/** What the sheet shows: the title and body for where the file is used, and the parent to open. */
export interface AssetInUseState {
  title: string;
  message: string;
  parent: AssetParent | null;
}

interface AssetInUseSheetProps {
  state: AssetInUseState | null;
  onOpenParent: (parent: AssetParent) => void;
  onClose: () => void;
}

/**
 * Shown when a delete is refused because a live post, brief or comment still
 * uses the file. The title and body name which one (never "delete the brief":
 * briefs are read-only). Offers the parent (when the lookup found one) and OK. Both
 * actions are 44px (Button size lg); colours are tokens via Button and Sheet.
 */
export function AssetInUseSheet({ state, onOpenParent, onClose }: AssetInUseSheetProps) {
  // Keep the last content through the Sheet's exit so it never blanks mid-fade.
  const shown = useRef<AssetInUseState | null>(state);
  if (state !== null) shown.current = state;
  const parent = shown.current?.parent ?? null;
  return (
    <Sheet
      open={state !== null}
      onClose={onClose}
      title={shown.current?.title ?? 'File in use'}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button onClick={onClose}>OK</Button>
          {parent !== null ? (
            <Button variant="primary" onClick={() => onOpenParent(parent)}>
              {openParentLabel(parent.kind)}
            </Button>
          ) : null}
        </div>
      }
    >
      <p className="text-base text-fg-2 [overflow-wrap:anywhere]">{shown.current?.message ?? ''}</p>
    </Sheet>
  );
}
