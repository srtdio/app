// Navigation helpers for the Assets surface that never replace the current tab.
//
// Two distinct behaviours:
//   - openLinkInNewTab: external links open in a *new* tab, leaving Sorted in
//     place. Severs the opener reference so the new tab cannot reach back into
//     this window, and falls back to an anchor click when a synchronous
//     window.open is blocked by the popup blocker.
//   - downloadFile: a stored file is saved in place. The presigned URL it
//     resolves carries Content-Disposition: attachment, so a plain same-window
//     anchor click downloads without navigating. No new tab, no window.open.

/** Click a throwaway anchor, optionally targeting a new tab. */
function clickAnchor(url: string, newTab: boolean): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  if (newTab) {
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
  }
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * Open `url` in a new browser tab without ever navigating the current one.
 * Tries a synchronous window.open (so it counts as a user gesture), nulls the
 * opener on success, and falls back to a temporary anchor when the popup is
 * blocked.
 */
export function openLinkInNewTab(url: string): void {
  const opened = window.open(url, '_blank');
  if (opened !== null) {
    opened.opener = null;
    return;
  }
  clickAnchor(url, true);
}

/**
 * Resolve an attachment-disposition presigned URL, then trigger the download via
 * a same-window anchor click. Because the URL responds with
 * Content-Disposition: attachment the browser saves the file in place and the
 * current page never navigates. Rejects if `resolve` rejects so the caller can
 * surface a failure toast.
 */
export async function downloadFile(resolve: () => Promise<string>): Promise<void> {
  const url = await resolve();
  clickAnchor(url, false);
}
