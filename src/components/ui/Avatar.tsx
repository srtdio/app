import { useState, type CSSProperties } from 'react';
import { cn } from '@/lib/cn';
import { IconUser } from '@/components/ui/icons';

/**
 * Where an avatar sits; the role alone decides its size. 'inline' (20) beside a
 * name in a meta line; 'stack' (24) in a chat replies row's repliers (L3); 'header' (32) in a thread or detail header; 'row' (40)
 * in a list row (members, search, pickers); 'card' (48, 40 in Compact density) as
 * a list row's picture (ui/ListCard; <html data-density> through CSS); 'profile' (72) on a profile or group info screen.
 * No other sizes.
 */
export type AvatarRole = 'inline' | 'stack' | 'header' | 'row' | 'card' | 'profile';

/** Who the avatar stands for: people, groups and personal notes all draw the same rounded square. */
type AvatarKind = 'person' | 'group' | 'note';

interface AvatarProps {
  name?: string;
  src?: string;
  role: AvatarRole;
  /** Defaults to 'person' (rounded square, like every kind). */
  kind?: AvatarKind;
  /** 'online' adds a bottom-right presence dot (and "online" to the name); absent renders no dot. */
  presence?: 'online' | undefined;
  /**
   * A visible name sits right beside the avatar: the picture is decoration
   * (alt="", hidden from screen readers) so the name is not read twice.
   */
  decorative?: boolean;
}

/** The avatar's accessible name: the person's name, plus "online" with the presence dot. Pure. */
export function avatarLabel(name: string | undefined, online: boolean): string {
  const parts = [name !== undefined && name.trim() !== '' ? name : null, online ? 'online' : null];
  return parts.filter((part): part is string => part !== null).join(', ');
}

/** The pixel size of each role (exported for tests and for layout that must line up with it). */
export const AVATAR_PX: Record<AvatarRole, number> = {
  inline: 20,
  stack: 24,
  header: 32,
  row: 40,
  // 48 in Cozy and Calm; Compact draws it 40 through the compact: variant (CARD_SIZE).
  card: 48,
  profile: 72,
};

const INITIALS_TYPE: Record<AvatarRole, string> = {
  inline: 'text-xs',
  stack: 'text-xs',
  header: 'text-sm',
  row: 'text-base',
  card: 'text-base',
  profile: 'text-2xl',
};

// Token-driven fills (--avatar-1..6 in index.css, light and dark), each 4.5:1 or
// more under the white initials. Full class names so Tailwind's scan keeps them.
const PALETTE = [
  'bg-avatar-1',
  'bg-avatar-2',
  'bg-avatar-3',
  'bg-avatar-4',
  'bg-avatar-5',
  'bg-avatar-6',
] as const;

/** The deterministic fill class for a name, drawn from the avatar palette. */
export function avatarFillFor(name: string): string {
  let sum = 0;
  for (let i = 0; i < name.length; i += 1) {
    sum += name.charCodeAt(i);
  }
  return PALETTE[sum % PALETTE.length] ?? 'bg-avatar-1';
}

/** One or two initials for a name (first and last word). */
export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.charAt(0) ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';
  return (first + last).toUpperCase();
}

/**
 * One shape rule for every kind (people, groups, personal notes): a rounded
 * square, rounded-lg (8) at 48 and below, rounded-xl above. People are square
 * like groups since 8 Nov 2026 (work chat, Slack way). The kind is kept for the
 * fill and the label only.
 */
export function avatarShapeClass(role: AvatarRole): string {
  return AVATAR_PX[role] <= 48 ? 'rounded-lg' : 'rounded-xl';
}

const base = 'lit-avatar inline-flex shrink-0 items-center justify-center select-none';

/**
 * 'card' follows the density (ui/ListCard picture): sized by classes, not the
 * inline style, so <html data-density="compact"> draws it 40 with no prop.
 */
const CARD_SIZE = 'h-12 w-12 compact:h-10 compact:w-10';

/** The inline size for a role: none for 'card' (CARD_SIZE classes size it). */
function sizeStyle(role: AvatarRole, px: number): CSSProperties | undefined {
  return role === 'card' ? undefined : { width: px, height: px };
}

export function Avatar({ presence, ...props }: AvatarProps) {
  if (presence !== 'online') return <AvatarFace {...props} />;
  return (
    <span className="relative inline-flex shrink-0">
      <AvatarFace {...props} online />
      <span
        data-presence="online"
        aria-hidden="true"
        className="lit-avatar absolute bottom-0 right-0 h-3 w-3 rounded-full bg-good outline outline-2 outline-panel"
      />
    </span>
  );
}

function AvatarFace({
  name,
  src,
  role,
  kind = 'person',
  decorative = false,
  online = false,
}: Omit<AvatarProps, 'presence'> & { online?: boolean }) {
  const [errored, setErrored] = useState(false);
  const label = avatarLabel(name, online);
  // Decorative: hidden. Online: the face is an image named "{name}, online"
  // (the dot itself is aria-hidden). Otherwise the face reads as before.
  const a11y = decorative
    ? { 'aria-hidden': true as const }
    : online && label !== ''
      ? { role: 'img', 'aria-label': label }
      : {};
  const px = AVATAR_PX[role];
  const box = cn(avatarShapeClass(role), base, role === 'card' && CARD_SIZE);
  const style = sizeStyle(role, px);

  if (src !== undefined && !errored) {
    return (
      <img
        src={src}
        alt={decorative ? '' : label}
        width={px}
        height={px}
        style={style}
        data-avatar-role={role}
        onError={() => setErrored(true)}
        className={cn(box, 'object-cover')}
      />
    );
  }

  if (name !== undefined && name.length > 0) {
    return (
      <div
        style={style}
        data-avatar-role={role}
        {...a11y}
        className={cn(box, avatarFillFor(name), 'text-avatar-ink font-medium', INITIALS_TYPE[role])}
      >
        {initialsFor(name)}
      </div>
    );
  }

  return (
    <div
      style={style}
      data-avatar-role={role}
      {...a11y}
      className={cn(box, 'bg-accent-soft border border-border text-accent')}
    >
      <IconUser size={Math.round(px * 0.6)} />
    </div>
  );
}
