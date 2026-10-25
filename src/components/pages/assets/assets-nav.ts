// Pure helpers behind the Assets page's URL state, in-app links, delete copy and
// selection. React-free so each rule is unit-tested without a DOM.

/** The library's name, everywhere it is shown (upload copy). */
export const ROOT_LABEL = 'All files';

/** The search param that opens one asset in the viewer (the existing email deep link). */
export const ASSET_PARAM = 'asset';

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

/** Where deleted files wait 31 days before they are gone for good. */
export const RECENTLY_DELETED_PATH = '/deleted';

/** The Recently deleted link and toast action label. */
export const RECENTLY_DELETED_LABEL = 'Recently deleted';

/** The toast when ?asset= names a file that is deleted or not in this library. */
export const ASSET_GONE_TOAST = 'This file was deleted.';

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
