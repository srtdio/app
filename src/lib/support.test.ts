import { describe, expect, it } from 'vitest';
import {
  anotherWorkspaceBody,
  anotherWorkspaceMailto,
  anotherWorkspaceRequest,
  moreGroupsBody,
  moreGroupsMailto,
  moreGroupsRequest,
} from '@/lib/support';

describe('support asks', () => {
  it('more groups: suggested line and mailto', () => {
    expect(moreGroupsBody('Acme - LinkedIn')).toBe("Hi, we'd like more groups in Acme - LinkedIn.");
    const href = moreGroupsMailto('Acme - LinkedIn');
    expect(href.startsWith('mailto:support@srtd.io?')).toBe(true);
    expect(href).toContain('subject=More%20groups%20for%20Acme%20-%20LinkedIn');
    expect(decodeURIComponent(href)).toContain(
      "body=Hi, we'd like more groups in Acme - LinkedIn.",
    );
    expect(href).not.toContain('+');
    expect(moreGroupsRequest('Acme - LinkedIn')).toEqual({
      body: moreGroupsBody('Acme - LinkedIn'),
      mailto: href,
    });
  });

  it('another workspace: the three old callers keep the same text', () => {
    expect(anotherWorkspaceRequest('Acme')).toEqual({
      body: "Hi, I'm on Acme and need another workspace.",
      mailto: anotherWorkspaceMailto('Acme'),
    });
    expect(anotherWorkspaceRequest('Acme').body).toBe(anotherWorkspaceBody('Acme'));
  });
});
