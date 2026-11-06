import { cn } from '@/lib/cn';
import { ICON_SIZE, IconPlay } from '@/components/ui/icons';

/** What a post with no picture shows: "Aa" for a text post, the play glyph for a video. */
export type PostPlaceholderKind = 'text' | 'video';

/** Formats whose media is a video. */
const VIDEO_FORMATS: readonly string[] = ['video', 'reel', 'story', 'short'];

/** The placeholder kind for a post format (null or unknown reads as text). Pure. */
export function postPlaceholderKind(format: string | null | undefined): PostPlaceholderKind {
  return format !== null && format !== undefined && VIDEO_FORMATS.includes(format)
    ? 'video'
    : 'text';
}

type GlyphSize = (typeof ICON_SIZE)[keyof typeof ICON_SIZE];

/** "Aa" drawn at the glyph's size on the type scale (it stands where an icon would). */
const AA_SIZE: Record<GlyphSize, string> = {
  12: 'text-xs',
  16: 'text-md',
  18: 'text-base',
  20: 'text-lg',
  22: 'text-xl',
  28: 'text-2xl',
};

/**
 * The one "no picture" placeholder for a post, everywhere a post shows
 * without a picture (Pipeline cards, chat post covers, post chips, marks):
 * "Aa" for a text post, the play glyph for a video. fg-3 ink. `fill` makes it
 * the whole box (the quiet panel-3 fill, glyph centred); without it, only the
 * glyph, for a box the caller already draws. Decorative unless `label` names
 * it (role img).
 */
export function PostPlaceholder({
  kind,
  size = ICON_SIZE.nav,
  fill = false,
  label,
  className,
}: {
  kind: PostPlaceholderKind;
  size?: GlyphSize;
  fill?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <span
      data-post-placeholder={kind}
      {...(label !== undefined ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      className={cn(
        'inline-flex shrink-0 items-center justify-center text-fg-3',
        fill && 'h-full w-full bg-panel-3',
        className,
      )}
    >
      {kind === 'video' ? (
        <IconPlay size={size} />
      ) : (
        <span className={cn('font-semibold', AA_SIZE[size])}>Aa</span>
      )}
    </span>
  );
}
