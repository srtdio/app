import { Avatar } from '@/components/ui/Avatar';

interface AvatarStackProps {
  /** Distinct display names, in order. */
  names: string[];
  /** Avatar size; defaults to the 24px small avatar. */
  size?: 'sm' | 'md' | 'lg';
}

const MAX = 3;

/**
 * A small overlapping avatar stack composed from the shared Avatar (there is no
 * AvatarStack primitive). Shows up to three avatars; any beyond that collapse
 * into a "+N" indicator. Renders nothing when there are no names.
 */
export function AvatarStack({ names, size = 'sm' }: AvatarStackProps) {
  if (names.length === 0) return null;
  const shown = names.slice(0, MAX);
  const extra = names.length - shown.length;
  return (
    <div className="flex items-center">
      {shown.map((name, i) => (
        <span
          key={`${name}-${i}`}
          className="rounded-full ring-2 ring-panel"
          style={{ marginLeft: i === 0 ? 0 : -8 }}
        >
          <Avatar name={name} size={size} />
        </span>
      ))}
      {extra > 0 ? (
        <span
          className="ml-[-8px] inline-flex h-6 items-center rounded-full bg-panel-2 px-1.5 text-[11px] font-medium text-fg-3 ring-2 ring-panel"
          aria-label={`${extra} more`}
        >
          +{extra}
        </span>
      ) : null}
    </div>
  );
}
