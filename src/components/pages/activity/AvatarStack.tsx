import type { ReactElement } from 'react';
import { AVATAR_PX, Avatar, type AvatarRole } from '@/components/ui/Avatar';
import { PersonTrigger } from '@/components/ui/PersonTrigger';

interface AvatarStackProps {
  /** Distinct display names, in order. */
  names: string[];
  /** Avatar role (it alone decides the size); defaults to the 20px inline avatar. */
  role?: AvatarRole;
  /**
   * The people behind `names`, index for index: an avatar with a user id opens
   * that person's card. Absent (or a null id): the avatar is a plain picture.
   */
  people?: readonly { userId: string | null; avatarUrl: string | null }[];
}

const MAX = 3;

/** How far each avatar (and the "+N" pill) tucks under the one before it, in px. */
export const STACK_OVERLAP_PX = 4;

/**
 * A small overlapping avatar stack composed from the shared Avatar (there is no
 * AvatarStack primitive). Shows up to three avatars; any beyond that collapse
 * into a "+N" indicator. Renders nothing when there are no names. It sits on the
 * page background, so the separating ring is ring-bg (light and dark), and each
 * avatar overlaps the last by only 4px so every initial reads.
 */
export function AvatarStack({ names, role = 'inline', people }: AvatarStackProps) {
  if (names.length === 0) return null;
  const shown = names.slice(0, MAX);
  const extra = names.length - shown.length;
  return (
    <div className="flex items-center">
      {shown.map((name, i) => (
        <span
          key={`${name}-${i}`}
          className="rounded-full ring-2 ring-bg"
          style={{ marginLeft: i === 0 ? 0 : -STACK_OVERLAP_PX }}
        >
          {personAvatar(<Avatar name={name} role={role} />, name, people?.[i])}
        </span>
      ))}
      {extra > 0 ? (
        <span
          className="ml-[-4px] inline-flex items-center rounded-full bg-panel-2 px-1.5 text-xs font-medium text-fg-3 ring-2 ring-bg"
          style={{ height: AVATAR_PX[role] }}
          aria-label={`${extra} more`}
        >
          +{extra}
        </span>
      ) : null}
    </div>
  );
}

/** One stack avatar, wrapped in its person card trigger when the person is known. */
function personAvatar(
  avatar: ReactElement,
  name: string,
  person: { userId: string | null; avatarUrl: string | null } | undefined,
): ReactElement {
  if (person === undefined || person.userId === null) return avatar;
  return (
    <PersonTrigger userId={person.userId} name={name} avatarUrl={person.avatarUrl} display="block">
      {avatar}
    </PersonTrigger>
  );
}
