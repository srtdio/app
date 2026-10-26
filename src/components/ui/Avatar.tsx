import { useState, type CSSProperties } from 'react';
import { cn } from '@/lib/cn';
import { IconUser } from '@/components/ui/icons';

/**
 * Where an avatar sits; the role alone decides its size. 'inline' (20) beside a
 * name in a meta line; 'header' (32) in a thread or detail header; 'row' (40)
 * in a list row (chat list, members, search, pickers); 'profile' (72) on a
 * profile or group info screen. No other sizes.
 */
export type AvatarRole = 'inline' | 'header' | 'row' | 'profile';

/** Who the avatar stands for: people are circles, groups and personal notes rounded squares. */
type AvatarKind = 'person' | 'group' | 'note';

interface AvatarProps {
  name?: string;
  src?: string;
  role: AvatarRole;
  /** Defaults to 'person' (circle). */
  kind?: AvatarKind;
  /** 'online' adds a bottom-right presence dot; absent renders no dot. */
  presence?: 'online' | undefined;
}

/** The pixel size of each role (exported for tests and for layout that must line up with it). */
export const AVATAR_PX: Record<AvatarRole, number> = {
  inline: 20,
  header: 32,
  row: 40,
  profile: 72,
};

const INITIALS_TYPE: Record<AvatarRole, string> = {
  inline: 'text-xs',
  header: 'text-sm',
  row: 'text-base',
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

/** The shape class for a kind at a role: circle for people; rounded-lg at 40 and below, rounded-xl above. */
export function avatarShapeClass(role: AvatarRole, kind: AvatarKind = 'person'): string {
  if (kind === 'person') return 'rounded-full';
  return AVATAR_PX[role] <= 40 ? 'rounded-lg' : 'rounded-xl';
}

const base = 'inline-flex shrink-0 items-center justify-center select-none';

export function Avatar({ presence, ...props }: AvatarProps) {
  if (presence !== 'online') return <AvatarFace {...props} />;
  return (
    <span className="relative inline-flex shrink-0">
      <AvatarFace {...props} />
      <span
        data-presence="online"
        aria-hidden="true"
        className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-good ring-2 ring-panel"
      />
    </span>
  );
}

function AvatarFace({ name, src, role, kind = 'person' }: Omit<AvatarProps, 'presence'>) {
  const [errored, setErrored] = useState(false);
  const px = AVATAR_PX[role];
  const box = `${avatarShapeClass(role, kind)} ${base}`;
  const style: CSSProperties = { width: px, height: px };

  if (src !== undefined && !errored) {
    return (
      <img
        src={src}
        alt={name ?? ''}
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
        className={cn(box, avatarFillFor(name), 'text-white font-medium', INITIALS_TYPE[role])}
      >
        {initialsFor(name)}
      </div>
    );
  }

  return (
    <div
      style={style}
      data-avatar-role={role}
      className={cn(box, 'bg-accent-soft border border-accent-line text-accent')}
    >
      <IconUser size={Math.round(px * 0.6)} />
    </div>
  );
}
