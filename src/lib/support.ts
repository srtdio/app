// Support contact for the app: one address, and the mailto links built on it.

export const SUPPORT_EMAIL = 'support@srtd.io';

/** A mailto: link to support, with optional subject and body. */
function supportMailto(input: { subject?: string; body?: string } = {}): string {
  const params = new URLSearchParams();
  if (input.subject) params.set('subject', input.subject);
  if (input.body) params.set('body', input.body);
  // URLSearchParams encodes spaces as '+', which mail clients show literally.
  const query = params.toString().replace(/\+/g, '%20');
  return query ? `mailto:${SUPPORT_EMAIL}?${query}` : `mailto:${SUPPORT_EMAIL}`;
}

/** The suggested line for asking for another workspace. */
export function anotherWorkspaceBody(workspaceName: string): string {
  return `Hi, I'm on ${workspaceName} and need another workspace.`;
}

/** The mailto link the Contact sheet opens for another workspace. */
export function anotherWorkspaceMailto(workspaceName: string): string {
  return supportMailto({
    subject: `Another workspace for ${workspaceName}`,
    body: anotherWorkspaceBody(workspaceName),
  });
}
