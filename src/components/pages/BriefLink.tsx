import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { LinkButton } from '@/components/ui/LinkButton';
import { LinkPreviewCard } from '@/components/ui/LinkPreviewCard';
import { UnsafeLinkButton } from '@/components/ui/UnsafeLinkSheet';
import { checkLink } from '@/lib/links/safety';
import { previewClient, type LinkPreview, type PreviewClient } from '@/lib/links/preview';

/**
 * Whether a brief reference link earns the large preview card: only a full
 * preview whose og:image actually loaded. Anything else (no preview yet, a
 * text/login/bare answer, no image, an image that failed) stays the one-line
 * pill, so the giant letter placeholder never shows on a brief. Pure.
 */
export function briefLinkShowsCard(preview: LinkPreview | null, imageLoaded: boolean): boolean {
  return preview !== null && preview.type === 'full' && imageLoaded;
}

/**
 * One brief reference link: the one-line pill (domain and arrow) by default,
 * the unsafe pill for a link that fails the safety check, and the large preview
 * card once the page's og:image has loaded (probed off screen first, so a
 * missing or broken image never paints).
 */
export function BriefLink({
  url,
  domain,
  client: clientProp,
}: {
  url: string;
  domain: string;
  /** Tests inject a client; the app uses the shared one. */
  client?: PreviewClient;
}): ReactElement {
  const client = clientProp ?? previewClient();
  const safety = checkLink(url);
  const unsafe = safety.verdict === 'unsafe';
  const [preview, setPreview] = useState<LinkPreview | null>(() =>
    unsafe ? null : client.peek(url),
  );
  const [imageLoaded, setImageLoaded] = useState(false);

  useEffect(() => {
    if (unsafe || preview !== null) return;
    const controller = new AbortController();
    client.request(url, controller.signal).then(setPreview, () => undefined);
    return () => controller.abort();
  }, [client, preview, unsafe, url]);

  if (unsafe) {
    return (
      <UnsafeLinkButton url={url} reasons={safety.reasons} domain={domain} className="w-full" />
    );
  }

  const imageSrc = preview?.type === 'full' ? client.imageUrl(url) : null;
  if (briefLinkShowsCard(preview, imageLoaded)) {
    return <LinkPreviewCard url={url} client={client} className="w-full max-w-[420px]" />;
  }
  return (
    <>
      <LinkButton url={url} className="w-full" />
      {imageSrc !== null ? (
        <img
          src={imageSrc}
          alt=""
          aria-hidden="true"
          data-brief-link-probe=""
          className="hidden"
          onLoad={() => setImageLoaded(true)}
        />
      ) : null}
    </>
  );
}
