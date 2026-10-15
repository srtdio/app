/**
 * Cloudflare Pages preview deploys of the SPA (one per PR, see
 * .github/workflows/preview-deploy.yml) are served at
 * https://<alias>.srtdio-app.pages.dev. Subdomains of srtdio-app.pages.dev can
 * only be created by our own Pages project, so the Workers accept them as CORS
 * origins alongside their exact ALLOWED_ORIGINS list.
 */
const PREVIEW_ORIGIN = /^https:\/\/[a-z0-9-]+\.srtdio-app\.pages\.dev$/;

export function isPreviewOrigin(origin: string): boolean {
  return PREVIEW_ORIGIN.test(origin);
}
