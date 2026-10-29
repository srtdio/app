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

/** The suggested line and the mailto the Contact sheet offers, chosen by its caller. */
export interface ContactRequest {
  body: string;
  mailto: string;
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

/** The another-workspace ask (workspace switcher, full sheet, Settings > Storage). */
export function anotherWorkspaceRequest(workspaceName: string): ContactRequest {
  return {
    body: anotherWorkspaceBody(workspaceName),
    mailto: anotherWorkspaceMailto(workspaceName),
  };
}

/** The suggested line for asking for more chat groups in a workspace. */
export function moreGroupsBody(workspaceName: string): string {
  return `Hi, we'd like more groups in ${workspaceName}.`;
}

/** The mailto link the Contact sheet opens for more groups. */
export function moreGroupsMailto(workspaceName: string): string {
  return supportMailto({
    subject: `More groups for ${workspaceName}`,
    body: moreGroupsBody(workspaceName),
  });
}

/** The more-groups ask (New chat sheet, blocked New group). */
export function moreGroupsRequest(workspaceName: string): ContactRequest {
  return { body: moreGroupsBody(workspaceName), mailto: moreGroupsMailto(workspaceName) };
}
