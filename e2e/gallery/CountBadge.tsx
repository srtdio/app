import { cell, type GalleryCell } from './frame';
import { CountBadge } from '@/components/ui/CountBadge';
import { MAX_NUMBER } from './fixtures';

export const part = 'CountBadge';

export const cells: readonly GalleryCell[] = [
  cell('default', () => (
    <div className="flex flex-wrap items-start gap-2">
      <CountBadge count={3} />
      <CountBadge tone="section" count={3} />
    </div>
  )),
  cell('zero-items', () => (
    <div className="flex flex-wrap items-start gap-2">
      <CountBadge count={0} />
      <CountBadge tone="section" count={0} />
    </div>
  )),
  cell('one-item', () => (
    <div className="flex flex-wrap items-start gap-2">
      <CountBadge count={1} />
      <CountBadge tone="section" count={1} />
    </div>
  )),
  cell('max-number', () => (
    <div className="flex flex-wrap items-start gap-2">
      <CountBadge count={MAX_NUMBER} />
      <CountBadge tone="section" count={MAX_NUMBER} />
    </div>
  )),
  cell('narrow-320', () => <CountBadge count={12} />),
  cell('all-slots-on', () => <CountBadge tone="section" count="1/5" />),
  cell('all-slots-off', () => <CountBadge count={3} />),
];
