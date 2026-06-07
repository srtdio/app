import type { CSSProperties } from 'react';
import { cn } from '@/lib/cn';
import { IconUser } from '@/components/ui/icons';

interface AvatarProps {
  name?: string;
  src?: string;
  size?: 'sm' | 'md' | 'lg';
}

const PX: Record<NonNullable<AvatarProps['size']>, number> = { sm: 24, md: 26, lg: 32 };

const PALETTE = ['#5e6ad2', '#3e7d54', '#b8772b', '#c2392b', '#7a5ea8', '#2b8a9e'];

function colorFor(name: string): string {
  let sum = 0;
  for (let i = 0; i < name.length; i += 1) {
    sum += name.charCodeAt(i);
  }
  return PALETTE[sum % PALETTE.length] ?? '#5e6ad2';
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.charAt(0) ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';
  return (first + last).toUpperCase();
}

const base = 'rounded-full inline-flex items-center justify-center select-none';

export function Avatar({ name, src, size = 'md' }: AvatarProps) {
  const px = PX[size];
  const style: CSSProperties = { width: px, height: px };

  if (src !== undefined) {
    return <img src={src} alt={name ?? ''} style={style} className={cn(base, 'object-cover')} />;
  }

  if (name !== undefined && name.length > 0) {
    return (
      <div
        style={{ ...style, backgroundColor: colorFor(name) }}
        className={cn(base, 'text-white text-xs font-medium')}
      >
        {initialsFor(name)}
      </div>
    );
  }

  return (
    <div style={style} className={cn(base, 'bg-accent-soft border border-accent-line text-accent')}>
      <IconUser size={Math.round(px * 0.6)} />
    </div>
  );
}
