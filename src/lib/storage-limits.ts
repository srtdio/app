// Workspace storage limits, shared by the asset-upload Worker and the SPA.
// Pure constants so the SPA can import them without server code. CAP_BYTES is
// never printed: the UI only ever says "full".

/** One warning, at 800 MB of the 1 GB free allowance. */
export const WARN_AT_BYTES = 800 * 1024 * 1024;

/** Hard cap for non-exempt workspaces. */
export const CAP_BYTES = 950 * 1024 * 1024;
