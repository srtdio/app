// Navigation helpers for the Assets surface that never replace the current tab.
//
// Two distinct behaviours:
//   - openLinkInNewTab: external links open in a *new* tab, leaving Sorted in
//     place. Uses a temporary anchor with rel="noopener noreferrer" so the new
//     tab cannot reach back into this window. Avoids window.open entirely,
//     which on mobile can surface a transient blank tab and disorient the user.
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
 * Always uses a temporary anchor click (target="_blank",
 * rel="noopener noreferrer") rather than window.open, which on mobile can
 * surface a transient blank tab and disorient the user.
 */
export function openLinkInNewTab(url: string): void {
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
