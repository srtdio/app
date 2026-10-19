// Pure helpers behind the Assets page's URL state, in-app links, delete copy and
// selection. React-free so each rule is unit-tested without a DOM.

/** The library root's name, everywhere it is shown (breadcrumb, move sheet, copy). */
export const ROOT_LABEL = 'All assets';

/** The search param that holds the open folder. Absent at the root. */
export const FOLDER_PARAM = 'folder';

/** The search param that opens one asset in the viewer (the existing email deep link). */
export const ASSET_PARAM = 'asset';

/**
 * History state the page writes on each folder it pushes: how many folder
 * entries above the first Assets entry this one is. Back can only step up that
 * many folders before it leaves Assets.
 */
export interface FolderHistoryState {
  assetsFolderStack: number;
}

/** The folder stack depth recorded on a history entry; 0 when it is not ours. */
export function folderStackOf(state: unknown): number {
  if (typeof state !== 'object' || state === null) return 0;
  const value = (state as Partial<FolderHistoryState>).assetsFolderStack;
  return typeof value === 'number' && value > 0 ? Math.floor(value) : 0;
}

export type FolderStep =
  | { kind: 'back'; delta: number }
  | { kind: 'push'; stack: number }
  | { kind: 'replace'; stack: number };

/**
 * How to reach `target` from the open folder. `trail` is the open folder's path
 * from the root (ids, root excluded). Going to an ancestor steps Back through
 * the entries this page pushed, so Back afterwards keeps going up one folder
 * and then leaves Assets; when those entries are not there (a deep link) the
 * current entry is replaced instead. Anything else is a new entry.
 */
export function folderStep(
  trail: readonly string[],
  target: string | null,
  stack: number,
): FolderStep {
  const current = trail[trail.length - 1] ?? null;
  if (target === current) return { kind: 'replace', stack };
  const ancestorDepth = target === null ? 0 : trail.indexOf(target) + 1;
  if (target === null || ancestorDepth > 0) {
    const delta = trail.length - ancestorDepth;
    if (stack >= delta) return { kind: 'back', delta };
    return { kind: 'replace', stack: Math.max(0, stack - delta) };
  }
  return { kind: 'push', stack: stack + 1 };
}

/** The search string with the open folder set (or cleared at the root). */
export function withFolderParam(search: URLSearchParams, folderId: string | null): URLSearchParams {
  const next = new URLSearchParams(search);
  if (folderId === null) next.delete(FOLDER_PARAM);
  else next.set(FOLDER_PARAM, folderId);
  return next;
}

/** The open folder from the URL, or null at the root. */
export function folderFromParams(search: URLSearchParams): string | null {
  const value = search.get(FOLDER_PARAM);
  return value === null || value === '' ? null : value;
}

function joinOrigin(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, '')}${path}`;
}

/**
 * The in-app link to one asset: /assets?asset=<id>. It opens for any workspace
 * member behind sign-in and never expires (never a presigned storage URL).
 */
export function assetLink(origin: string, assetId: string): string {
  return joinOrigin(origin, `/assets?${ASSET_PARAM}=${encodeURIComponent(assetId)}`);
}

/** The in-app link to one folder: /assets?folder=<id>. */
export function folderLink(origin: string, folderId: string): string {
  return joinOrigin(origin, `/assets?${FOLDER_PARAM}=${encodeURIComponent(folderId)}`);
}

/** Where deleted files wait 31 days before they are gone for good. */
export const RECENTLY_DELETED_PATH = '/deleted';

/** The Recently deleted link and toast action label. */
export const RECENTLY_DELETED_LABEL = 'Recently deleted';

/** The toast when ?asset= names a file that is deleted or not in this library. */
export const ASSET_GONE_TOAST = 'This file was deleted.';

/** The Undo toast title for a folder delete. */
export const FOLDER_DELETED_LABEL = 'Folder deleted';

/** The Undo toast title for a delete of `count` files: Undo now, or restore later. */
export function deleteToastLabel(count: number): string {
  return count === 1
    ? 'File deleted. Undo or find it in Recently deleted.'
    : `${count} files deleted. Undo or find them in Recently deleted.`;
}

/** The toast when a selection reaches the batch cap. Pure. */
export function selectCapLabel(cap: number): string {
  return `You can select up to ${cap} files at once.`;
}

/** The toast when Select all stops at the batch cap. Pure. */
export function selectAllCapLabel(cap: number): string {
  return `Selected the first ${cap}. You can select up to ${cap} files at once.`;
}

/**
 * Whether ?asset= should report the file as gone: the library has loaded (an
 * empty library counts) and no row has that id. Pure.
 */
export function assetParamIsGone(
  loaded: boolean,
  items: readonly { id: string }[],
  assetId: string,
): boolean {
  return loaded && !items.some((item) => item.id === assetId);
}

/** The failure toast when a delete could not be saved; the files are back. */
export function deleteFailedLabel(count: number): string {
  return count === 1
    ? "Couldn't delete the file. Try again."
    : "Couldn't delete the files. Try again.";
}

/** The select-mode count line. */
export function selectedLabel(count: number): string {
  return `${count} selected`;
}

/** Ids for Select all: every shown file, capped at `cap` (the batch limit). */
export function selectAllIds(visible: readonly { id: string }[], cap: number): string[] {
  return visible.slice(0, cap).map((item) => item.id);
}
